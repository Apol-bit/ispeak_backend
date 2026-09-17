const LearningResource = require('../models/LearningResource');
const { storage } = require('../services/storageService');

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
    const resources = await LearningResource.find(filter).sort({ createdAt: -1 });
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

    // Handle reference audio file upload (from Validator)
    // TODO [CLOUD]: Same as createResource — replace with cloud upload logic.
    let oldAudioKey = null;
    if (req.file) {
      const oldResource = await LearningResource.findById(req.params.id);
      if (!oldResource) {
        await deleteStoredFile(storage.toKey(req.file.path), 'orphaned resource upload');
        return res.status(404).json({ message: "Resource not found" });
      }
      oldAudioKey = oldResource.referenceAudioPath;
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
