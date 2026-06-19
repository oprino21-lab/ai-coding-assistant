const OpenAI = require('openai');
const logger = require('../utils/logger');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set');
  return new OpenAI({ apiKey });
}

/**
 * Core OpenAI API call — single model, clean error messages.
 */
async function callOpenAI(messages, options = {}) {
  const { maxTokens = 4096, temperature = 0.2 } = options;

  const client = getClient();
  logger.info(`Calling OpenAI model: ${MODEL}`);

  try {
    const response = await client.chat.completions.create({
      model:       MODEL,
      messages,
      max_tokens:  maxTokens,
      temperature
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned an empty response');
    logger.info('OpenAI call succeeded');
    return content;

  } catch (err) {
    const status  = err.status ?? err.response?.status;
    const detail  = err.message || 'Unknown error';
    const msg     = `OpenAI API error (${status ?? 'network'}): ${detail}`;
    logger.error(msg);
    throw new Error(msg);
  }
}

/**
 * Parse a JSON block from raw AI text.
 * Returns the parsed object or a safe fallback.
 */
function parseJSON(raw, fallback) {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : raw);
  } catch (_) {
    return fallback;
  }
}

/**
 * Safely convert any value to a non-empty string array.
 */
function toStringArray(val) {
  if (Array.isArray(val)) return val.filter(v => v && typeof v === 'string');
  return [];
}

/* ── Phase 1: Think & Plan ──────────────────────────────────────── */
async function thinkAndPlan(userInstruction, repoAnalysis) {
  logger.info('AI thinking and planning...');

  const fileTree = Array.isArray(repoAnalysis?.fileTree) ? repoAnalysis.fileTree : [];
  const detected = Array.isArray(repoAnalysis?.techStack?.detected) ? repoAnalysis.techStack.detected : [];
  const keyConts = repoAnalysis?.keyContents && typeof repoAnalysis.keyContents === 'object'
    ? repoAnalysis.keyContents : {};

  const fileList       = fileTree.slice(0, 150).map(String).join('\n');
  const techStack      = detected.join(', ') || 'Unknown';
  const keyFileSummary = Object.entries(keyConts)
    .map(([file, content]) => `=== ${file} ===\n${String(content).substring(0, 2000)}`)
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content:
        'You are CodeLite, an expert AI coding assistant. ' +
        'Analyze codebases carefully and plan changes step-by-step before implementing them. ' +
        'Respond ONLY with valid JSON — no markdown, no extra text.'
    },
    {
      role: 'user',
      content:
`## Repository Info
Tech Stack: ${techStack}
Total Files: ${repoAnalysis?.totalFiles ?? 0}

## File Tree (first 150 files)
${fileList || '(empty repo)'}

## Key File Contents
${keyFileSummary || '(none)'}

## User Instruction
"${userInstruction}"

## Task
Respond ONLY with this JSON:
{
  "understanding": "what the codebase does and what the user wants",
  "impactedFiles": ["path/to/existing/file"],
  "newFiles": ["path/to/new/file"],
  "plan": ["Step 1: ...", "Step 2: ..."],
  "risks": ["potential issue"],
  "summary": "one-line summary of changes"
}`
    }
  ];

  const raw  = await callOpenAI(messages, { temperature: 0.1, maxTokens: 2000 });
  const plan = parseJSON(raw, {
    understanding: raw,
    impactedFiles: [],
    newFiles:      [],
    plan:          ['(plan could not be parsed — raw AI response stored in understanding)'],
    risks:         [],
    summary:       userInstruction
  });

  plan.impactedFiles = toStringArray(plan.impactedFiles);
  plan.newFiles      = toStringArray(plan.newFiles);
  plan.plan          = toStringArray(plan.plan);
  plan.risks         = toStringArray(plan.risks);

  logger.info(`Plan ready — impacted: [${plan.impactedFiles.join(', ')}] | new: [${plan.newFiles.join(', ')}]`);
  return plan;
}

/* ── Phase 2: Generate Code Changes ────────────────────────────── */
async function generateCodeChanges(userInstruction, plan, repoAnalysis, existingContents) {
  logger.info('AI generating code changes...');

  const impacted = toStringArray(plan.impactedFiles);
  const newFiles = toStringArray(plan.newFiles);
  const steps    = toStringArray(plan.plan);
  const detected = Array.isArray(repoAnalysis?.techStack?.detected) ? repoAnalysis.techStack.detected : [];

  const filesToChange = [...impacted, ...newFiles];
  const existingCode  = filesToChange
    .map(f => `=== ${f} (${existingContents[f] ? 'existing' : 'new file'}) ===\n${existingContents[f] || '[create new file]'}`)
    .join('\n\n') || '(no existing files to show)';

  const messages = [
    {
      role: 'system',
      content:
        'You are CodeLite, an expert AI coding assistant. ' +
        'Generate precise, complete, production-ready code. ' +
        'NEVER use placeholder comments like "// rest of code here". ' +
        'Respond ONLY with valid JSON — no markdown fences, no extra text.'
    },
    {
      role: 'user',
      content:
`## User Instruction
"${userInstruction}"

## Implementation Plan
${steps.join('\n') || '(no plan steps)'}

## Existing File Contents
${existingCode}

## Tech Stack
${detected.join(', ') || 'Unknown'}

## Task
Respond ONLY with this JSON:
{
  "changes": [
    {
      "path": "relative/path/to/file",
      "action": "create or modify",
      "content": "complete file content",
      "description": "what changed and why"
    }
  ],
  "commitMessage": "feat: short description",
  "explanation": "overall summary of all changes"
}`
    }
  ];

  const raw    = await callOpenAI(messages, { temperature: 0.15, maxTokens: 8000 });
  const result = parseJSON(raw, null);

  if (!result || !Array.isArray(result.changes) || result.changes.length === 0) {
    throw new Error('AI did not return valid code changes. Please rephrase your instruction and try again.');
  }

  logger.info(`Generated ${result.changes.length} file change(s)`);
  return result;
}

/* ── Explain a file ─────────────────────────────────────────────── */
async function explainCode(code, filePath) {
  logger.info(`Explaining file: ${filePath}`);
  const messages = [
    {
      role: 'system',
      content: 'You are CodeLite, an expert code explainer. Give clear, concise explanations for developers.'
    },
    {
      role: 'user',
      content:
        `Explain this code from \`${filePath}\`:\n\n\`\`\`\n${code}\n\`\`\`\n\n` +
        'Cover: purpose, how it works, key functions/classes, dependencies, and any potential issues.'
    }
  ];
  return callOpenAI(messages, { temperature: 0.3, maxTokens: 2000 });
}

module.exports = { thinkAndPlan, generateCodeChanges, explainCode, callOpenAI };
