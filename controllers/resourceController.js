const LearningResource = require('../models/LearningResource');
const mongoose = require('mongoose');
const { storage } = require('../services/storageService');

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
  if (!key) return;
  try {
    await storage.delete(key);
  } catch (error) {
    console.error(`Unable to delete ${context}:`, error);
  }
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
    console.error("Error fetching resources:", error);
    res.status(500).json({ message: "Error fetching resources" });
  }
};

// CREATE A RESOURCE (supports multipart/form-data with reference audio upload)
exports.createResource = async (req, res) => {
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

    // Handle reference audio file upload (from Validator)
    // TODO [CLOUD]: Replace local file storage with cloud upload (S3/GCS).
    //   Use a service like aws-sdk or @google-cloud/storage to upload req.file.buffer
    //   and store the returned URL in referenceAudioPath instead of the local path.
    if (req.file) {
      resourceData.referenceAudioPath = storage.toKey(req.file.path);
    }

    resourceData.displayOrder = await nextDisplayOrder(resourceData);
    const newResource = new LearningResource(resourceData);
    await newResource.save();
    res.status(201).json({ message: "Resource created successfully!", resource: newResource });
  } catch (error) {
    if (req.file) {
      await deleteStoredFile(storage.toKey(req.file.path), 'failed resource upload');
    }
    console.error("Error creating resource:", error);
    res.status(500).json({ message: "Error creating learning resource" });
  }
};

// UPDATE A RESOURCE (supports multipart/form-data with reference audio upload)
exports.updateResource = async (req, res) => {
  let newAudioKey = null;
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
      if (req.file) await deleteStoredFile(storage.toKey(req.file.path), 'orphaned resource upload');
      return res.status(404).json({ message: "Resource not found" });
    }
    const targetResource = {
      type: updateData.type || existingResource.type,
      difficulty: updateData.difficulty || existingResource.difficulty
    };
    if (!sameGroup(existingResource, targetResource)) {
      updateData.displayOrder = await nextDisplayOrder(targetResource, existingResource._id);
    }

    // Handle reference audio file upload (from Validator)
    // TODO [CLOUD]: Same as createResource — replace with cloud upload logic.
    let oldAudioKey = null;
    if (req.file) {
      oldAudioKey = existingResource.referenceAudioPath;
      newAudioKey = storage.toKey(req.file.path);
      updateData.referenceAudioPath = newAudioKey;
    }

    const updatedResource = await LearningResource.findByIdAndUpdate(
      req.params.id, 
      updateData, 
      { new: true, runValidators: true }
    );
    if (!updatedResource) {
      await deleteStoredFile(newAudioKey, 'orphaned replacement upload');
      return res.status(404).json({ message: "Resource not found" });
    }
    if (oldAudioKey && oldAudioKey !== newAudioKey) {
      await deleteStoredFile(oldAudioKey, 'replaced resource audio');
    }
    res.status(200).json({ message: "Resource updated successfully!", resource: updatedResource });
  } catch (error) {
    await deleteStoredFile(newAudioKey, 'failed replacement upload');
    console.error("Error updating resource:", error);
    res.status(500).json({ message: "Error updating resource" });
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
    console.error('Error reordering resources:', error);
    return res.status(500).json({ message: 'Error reordering resources' });
  }
};

// DELETE A RESOURCE
exports.deleteResource = async (req, res) => {
  try {
    const resource = await LearningResource.findById(req.params.id);
    if (!resource) return res.status(404).json({ message: "Resource not found" });

    await LearningResource.findByIdAndDelete(req.params.id);
    await deleteStoredFile(resource.referenceAudioPath, 'deleted resource audio');
    res.status(200).json({ message: "Resource deleted successfully" });
  } catch (error) {
    console.error("Error deleting resource:", error);
    res.status(500).json({ message: "Error deleting resource" });
  }
};
