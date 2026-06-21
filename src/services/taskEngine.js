const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const tasks = new Map();

function createTask(userId, repoFullName, instruction) {
  const taskId = uuidv4();
  const task = {
    id:               taskId,
    userId,
    repoFullName,
    instruction,
    status:           'pending',
    plan:             null,
    changes:          null,
    appliedChanges:   null,
    error:            null,
    agentLog:         [],
    debugAttempts:    0,
    structuredReport: null,
    tokenUsage:       null,
    createdAt:        new Date().toISOString(),
    updatedAt:        new Date().toISOString()
  };
  tasks.set(taskId, task);
  logger.info(`Task created: ${taskId} for ${repoFullName}`);
  return task;
}

function updateTask(taskId, updates) {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
  tasks.set(taskId, task);
  return task;
}

function getTask(taskId) {
  return tasks.get(taskId) || null;
}

function getUserTasks(userId) {
  return Array.from(tasks.values())
    .filter(t => t.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function deleteTask(taskId) {
  return tasks.delete(taskId);
}

module.exports = { createTask, updateTask, getTask, getUserTasks, deleteTask };
