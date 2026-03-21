const LearningResource = require('../models/LearningResource');

// GET ALL RESOURCES
exports.getAllResources = async (req, res) => {
  try {
    const filter = req.query.type ? { type: req.query.type } : {};
    const resources = await LearningResource.find(filter).sort({ createdAt: -1 });
    res.status(200).json(resources);
  } catch (error) {
    console.error("Error fetching resources:", error);
    res.status(500).json({ message: "Error fetching resources" });
  }
};

// CREATE A RESOURCE
exports.createResource = async (req, res) => {
  try {
    const newResource = new LearningResource(req.body);
    await newResource.save();
    res.status(201).json({ message: "Resource created successfully!", resource: newResource });
  } catch (error) {
    console.error("Error creating resource:", error);
    res.status(500).json({ message: "Error creating learning resource" });
  }
};

// UPDATE A RESOURCE
exports.updateResource = async (req, res) => {
  try {
    const updatedResource = await LearningResource.findByIdAndUpdate(
      req.params.id, 
      req.body, 
      { new: true } 
    );
    if (!updatedResource) return res.status(404).json({ message: "Resource not found" });
    res.status(200).json({ message: "Resource updated successfully!", resource: updatedResource });
  } catch (error) {
    console.error("Error updating resource:", error);
    res.status(500).json({ message: "Error updating resource" });
  }
};

// DELETE A RESOURCE
exports.deleteResource = async (req, res) => {
  try {
    const deletedResource = await LearningResource.findByIdAndDelete(req.params.id);
    if (!deletedResource) return res.status(404).json({ message: "Resource not found" });
    res.status(200).json({ message: "Resource deleted successfully" });
  } catch (error) {
    console.error("Error deleting resource:", error);
    res.status(500).json({ message: "Error deleting resource" });
  }
};