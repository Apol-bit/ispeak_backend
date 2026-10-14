const LearningResource = require('../models/LearningResource');
const mongoose = require('mongoose');
const { storage } = require('../services/storageService');
const { audioStorage } = require('../services/audioStorageService');
const { storageFailure } = require('../services/storageErrors');
const { inspectAudio, AUDIO_TYPES } = require('../services/audioFile');
const { logError } = require('../services/safeLogger');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

function groupFilter(resource) {
  if (resource.type === 'GuidedTask') return { type: 'GuidedTask' };
  return { type: resource.type, difficulty: resource.difficulty || 'None' };
}

function sameGroup(first, second) {
  if (first.type !== second.type) return false;
  return first.type === 'GuidedTask' ||
    (first.difficulty || 'None') === (second.difficulty || 'None');
}

async function nextDisplayOrder(resource, excludeId) {
  const rows = await LearningResource.find(groupFilter(resource)).sort({
    displayOrder: 1, createdAt: -1, _id: 1
  });
  const eligible = rows.filter(row => String(row._id) !== String(excludeId || ''));
  const maximum = eligible.reduce((value, row) =>
    Math.max(value, Number.isInteger(row.displayOrder) ? row.displayOrder : 0), 0);
  return Math.max(maximum, eligible.length) + 1;
}

async function deleteStoredFile(key, context) {
  await audioStorage.removeIfUnreferenced(key);
}

// GET ALL RESOURCES
exports.getAllResources = async (req, res) => {
  try {
    const filter = req.query.type ? { type: req.query.type } : {};
    const resources = await LearningResource.find(filter).sort({
      type: 1,
      difficulty: 1,
      displayOrder: 1,
      createdAt: -1,
      _id: 1
    });
    if (req.auth.role === 'user') {
      return res.status(200).json(resources.map((resource) => {
        const safeResource = resource.toObject();
        delete safeResource.referenceAudioPath;
        return safeResource;
      }));
    }
    res.status(200).json(resources);
  } catch (error) {
    logError('resource_query_failed', error);
    res.status(500).json({ message: "Error fetching resources" });
  }
};

// CREATE A RESOURCE (supports multipart/form-data with reference audio upload)
exports.createResource = async (req, res) => {
  let saved = false;
  try {
    const resourceData = { ...req.body };
    delete resourceData.referenceAudioPath;
    delete resourceData.displayOrder;
    resourceData.createdBy = req.auth.userId;

    // Parse JSON fields that may arrive as strings from multipart form
    if (typeof resourceData.tips === 'string') {
      try { resourceData.tips = JSON.parse(resourceData.tips); } catch { /* keep as-is */ }
    }
    if (typeof resourceData.steps === 'string') {
      try { resourceData.steps = JSON.parse(resourceData.steps); } catch { /* keep as-is */ }
    }
    if (typeof resourceData.estimatedMinutes === 'string') {
      resourceData.estimatedMinutes = parseInt(resourceData.estimatedMinutes, 10) || 0;
    }
    if (typeof resourceData.timeLimitSeconds === 'string') {
      resourceData.timeLimitSeconds = parseInt(resourceData.timeLimitSeconds, 10) || 0;
    }

    resourceData.displayOrder = await nextDisplayOrder(resourceData);
    const newResource = new LearningResource(resourceData);
    if (req.file) {
      await inspectAudio(req.file.path);
      newResource.referenceAudioPath = await audioStorage.storeUpload(req.file, {
        category: 'reference_audio', ownerId: newResource._id,
      });
    }
    await newResource.save();
    saved = true;
    await audioStorage.committed(newResource.referenceAudioPath);
    await audioStorage.cleanupTemp(req.file, { preserveLocal: true });
    res.status(201).json({ message: "Resource created successfully!", resource: newResource });
  } catch (error) {
    console.error('Resource create failed; pending cloud uploads remain journaled.');
    await audioStorage.cleanupTemp(req.file);
    if (storageFailure(res, error)) return;
    res.status(500).json({ message: "Error creating learning resource" });
  } finally {
    await audioStorage.cleanupTemp(req.file, { preserveLocal: saved });
  }
};

// UPDATE A RESOURCE (supports multipart/form-data with reference audio upload)
exports.updateResource = async (req, res) => {
  let newAudioKey = null;
  let saved = false;
  try {
    const updateData = { ...req.body };
    delete updateData.displayOrder;
    delete updateData.referenceAudioPath;
    delete updateData.createdBy;

    // Parse JSON fields that may arrive as strings from multipart form
    if (typeof updateData.tips === 'string') {
      try { updateData.tips = JSON.parse(updateData.tips); } catch { /* keep as-is */ }
    }
    if (typeof updateData.steps === 'string') {
      try { updateData.steps = JSON.parse(updateData.steps); } catch { /* keep as-is */ }
    }
    if (typeof updateData.estimatedMinutes === 'string') {
      updateData.estimatedMinutes = parseInt(updateData.estimatedMinutes, 10) || 0;
    }
    if (typeof updateData.timeLimitSeconds === 'string') {
      updateData.timeLimitSeconds = parseInt(updateData.timeLimitSeconds, 10) || 0;
    }

    const existingResource = await LearningResource.findById(req.params.id);
    if (!existingResource) {
      await audioStorage.cleanupTemp(req.file);
      return res.status(404).json({ message: "Resource not found" });
    }
    const targetResource = {
      type: updateData.type || existingResource.type,
      difficulty: updateData.difficulty || existingResource.difficulty
    };
    if (!sameGroup(existingResource, targetResource)) {
      updateData.displayOrder = await nextDisplayOrder(targetResource, existingResource._id);
    }

    // Store the new object before changing the reference, then retire the old.
    let oldAudioKey = null;
    if (req.file) {
      oldAudioKey = existingResource.referenceAudioPath;
      await inspectAudio(req.file.path);
      await audioStorage.prepareRemoval(oldAudioKey);
      newAudioKey = await audioStorage.storeUpload(req.file, {
        category: 'reference_audio', ownerId: existingResource._id,
      });
      updateData.referenceAudioPath = newAudioKey;
    }

    const updatedResource = req.file && storage.driver === 'r2'
      ? await LearningResource.findOneAndUpdate(
        { _id: req.params.id, referenceAudioPath: existingResource.referenceAudioPath },
        updateData, { new: true, runValidators: true })
      : await LearningResource.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
    if (!updatedResource) {
      await deleteStoredFile(newAudioKey, 'orphaned replacement upload');
      await audioStorage.cleanupTemp(req.file);
      return res.status(req.file && storage.driver === 'r2' ? 409 : 404).json({ message: 'Resource changed or no longer exists. Refresh and try again.' });
    }
    saved = true;
    await audioStorage.committed(newAudioKey);
    if (oldAudioKey && oldAudioKey !== newAudioKey) {
      await deleteStoredFile(oldAudioKey, 'replaced resource audio');
    }
    await audioStorage.cleanupTemp(req.file, { preserveLocal: true });
    res.status(200).json({ message: "Resource updated successfully!", resource: updatedResource });
  } catch (error) {
    // DB timeout may have committed: let the journal check references later.
    console.error('Resource update failed; pending cloud cleanup remains journaled.');
    await audioStorage.cleanupTemp(req.file);
    if (storageFailure(res, error)) return;
    res.status(500).json({ message: "Error updating resource" });
  } finally {
    await audioStorage.cleanupTemp(req.file, { preserveLocal: saved });
  }
};

// SAVE THE COMPLETE ORDER OF ONE TYPE + LEVEL GROUP
exports.reorderResources = async (req, res) => {
  try {
    const { type, difficulty, orderedIds } = req.body || {};
    if (!['Script', 'Challenge', 'GuidedTask'].includes(type)) {
      return res.status(400).json({ message: 'Invalid resource type' });
    }
    if (type !== 'GuidedTask' &&
        !['Beginner', 'Intermediate', 'Advanced', 'None'].includes(difficulty)) {
      return res.status(400).json({ message: 'Invalid resource difficulty' });
    }
    if (!Array.isArray(orderedIds) || orderedIds.length === 0 ||
        new Set(orderedIds).size !== orderedIds.length ||
        orderedIds.some(id => !mongoose.Types.ObjectId.isValid(id))) {
      return res.status(400).json({ message: 'orderedIds must contain unique resource IDs' });
    }

    const resources = await LearningResource.find(groupFilter({ type, difficulty })).sort({
      displayOrder: 1, createdAt: -1, _id: 1
    });
    const groupIds = new Set(resources.map(resource => String(resource._id)));
    if (orderedIds.length !== groupIds.size || orderedIds.some(id => !groupIds.has(String(id)))) {
      return res.status(400).json({
        message: 'Order must contain every resource from exactly one type and level group'
      });
    }

    await LearningResource.bulkWrite(orderedIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { displayOrder: index + 1 } }
      }
    })));
    const byId = new Map(resources.map(resource => [String(resource._id), resource]));
    const ordered = orderedIds.map((id, index) => {
      const resource = byId.get(String(id));
      resource.displayOrder = index + 1;
      return resource;
    });
    return res.status(200).json({ resources: ordered });
  } catch (error) {
    logError('resource_reorder_failed', error);
    return res.status(500).json({ message: 'Error reordering resources' });
  }
};

// DELETE A RESOURCE
exports.deleteResource = async (req, res) => {
  try {
    const resource = await LearningResource.findById(req.params.id);
    if (!resource) return res.status(404).json({ message: "Resource not found" });

    await audioStorage.prepareRemoval(resource.referenceAudioPath);
    if (storage.driver === 'r2') {
      const deleted = await LearningResource.findOneAndDelete({
        _id: req.params.id, referenceAudioPath: resource.referenceAudioPath,
      });
      if (!deleted) return res.status(409).json({ message: 'Resource changed. Refresh and try again.' });
    } else {
      await LearningResource.findByIdAndDelete(req.params.id);
    }
    await deleteStoredFile(resource.referenceAudioPath, 'deleted resource audio');
    res.status(200).json({ message: "Resource deleted successfully" });
  } catch (error) {
    console.error('Resource deletion failed; cloud cleanup is retryable.');
    if (storageFailure(res, error)) return;
    res.status(500).json({ message: "Error deleting resource" });
  }
};

exports.getReferenceAudio = async (req, res) => {
  let stream;
  try {
    const resource = await LearningResource.findById(req.params.id);
    if (!resource?.referenceAudioPath) return res.status(404).json({ message: 'Reference audio not found' });
    stream = await storage.openReadStream(resource.referenceAudioPath);
    res.set('Content-Type', AUDIO_TYPES[path.posix.extname(resource.referenceAudioPath)] || 'application/octet-stream');
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    await pipeline(stream, res);
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    if (storageFailure(res, error)) return;
    res.status(503).json({ message: 'Reference audio storage is temporarily unavailable.' });
  } finally { stream?.destroy(); }
};
