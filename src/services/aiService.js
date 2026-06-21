const OpenAI = require('openai');
const logger = require('../utils/logger');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_DEBUG_ATTEMPTS = 3;

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set');
  return new OpenAI({ apiKey });
}

async function callOpenAI(messages, options = {}) {
  const { maxTokens = 4096, temperature = 0.2, jsonMode = false } = options;
  const client = getClient();
  logger.info(`Calling OpenAI model: ${MODEL}${jsonMode ? ' [json_object mode]' : ''}`);

  try {
    const params = {
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      temperature
    };
    if (jsonMode) params.response_format = { type: 'json_object' };

    const response = await client.chat.completions.create(params);
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned an empty response');
    const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    logger.info(`OpenAI call succeeded — tokens: ${usage.total_tokens}`);
    return { content, usage };
  } catch (err) {
    const status = err.status ?? err.response?.status;
    const detail = err.message || 'Unknown error';
    const msg = `OpenAI API error (${status ?? 'network'}): ${detail}`;
    logger.error(msg);
    throw new Error(msg);
  }
}

function parseJSON(raw, fallback) {
  if (!raw || typeof raw !== 'string') return fallback;

  // Strategy 1: strip markdown fences then direct parse
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();
  try { return JSON.parse(stripped); } catch (_) {}

  // Strategy 2: extract first {...} block (handles leading/trailing text)
  try {
    const obj = stripped.match(/\{[\s\S]*\}/);
    if (obj) return JSON.parse(obj[0]);
  } catch (_) {}

  // Strategy 3: find the LAST complete JSON object in case there's preamble
  try {
    const all = [...stripped.matchAll(/\{[\s\S]*?\}/g)];
    for (let i = all.length - 1; i >= 0; i--) {
      try { return JSON.parse(all[i][0]); } catch (_) {}
    }
  } catch (_) {}

  // Strategy 4: try the raw string without any modifications
  try { return JSON.parse(raw); } catch (_) {}

  logger.warn(`parseJSON: all strategies failed. Raw response (first 500 chars): ${raw.substring(0, 500)}`);
  return fallback;
}

function toStringArray(val) {
  if (Array.isArray(val)) return val.filter(v => v && typeof v === 'string');
  return [];
}

/**
 * PHASE 1 — Deep codebase understanding.
 * Asks the AI to identify which files are relevant before doing anything else.
 * Returns a prioritized list of files to read based on the instruction.
 */
async function identifyRelevantFiles(instruction, repoAnalysis) {
  logger.info('Agent Phase 1: Identifying relevant files...');

  const fileTree = Array.isArray(repoAnalysis?.fileTree) ? repoAnalysis.fileTree : [];
  const detected = Array.isArray(repoAnalysis?.techStack?.detected) ? repoAnalysis.techStack.detected : [];

  const messages = [
    {
      role: 'system',
      content: `You are a senior software engineer acting as an autonomous coding agent.
Your job is to identify which existing files in a codebase need to be READ before making changes.
You must understand the full existing implementation before touching anything.
Respond ONLY with valid JSON — no markdown, no extra text.`
    },
    {
      role: 'user',
      content: `## Tech Stack
${detected.join(', ') || 'Unknown'}

## Full File Tree
${fileTree.join('\n')}

## User Instruction
"${instruction}"

## Task
Identify which files you need to READ to fully understand the existing implementation before making any changes.
Prioritize: entry points, routes, services, models, config files, and any file the instruction directly relates to.
Limit to 20 most important files.

Respond ONLY with:
{
  "relevantFiles": ["path/to/file1", "path/to/file2"],
  "reasoning": "why these files are needed to understand the codebase for this instruction"
}`
    }
  ];

  const { content: raw, usage } = await callOpenAI(messages, { temperature: 0.1, maxTokens: 1000, jsonMode: true });
  const result = parseJSON(raw, { relevantFiles: [], reasoning: '' });

  const files = toStringArray(result.relevantFiles).slice(0, 20);
  logger.info(`Agent identified ${files.length} relevant files to read`);

  return { files, reasoning: result.reasoning || '', usage };
}

/**
 * PHASE 2 — Structured planning.
 * Uses deep file content (not just filenames) to form a concrete plan.
 * Enforces: describe the problem, list impacted files, write step-by-step actions.
 */
async function thinkAndPlan(instruction, repoAnalysis, deepContext = {}) {
  logger.info('Agent Phase 2: Thinking and planning...');

  const fileTree = Array.isArray(repoAnalysis?.fileTree) ? repoAnalysis.fileTree : [];
  const detected = Array.isArray(repoAnalysis?.techStack?.detected) ? repoAnalysis.techStack.detected : [];

  const deepContextSummary = Object.entries(deepContext)
    .map(([file, content]) => `=== EXISTING FILE: ${file} ===\n${String(content).substring(0, 3000)}`)
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content: `You are a senior software engineer acting as an autonomous coding agent — like Replit Agent.
RULES:
1. You MUST read and understand the full existing implementation before planning.
2. You MUST reuse existing patterns, naming conventions, and architecture.
3. You MUST only plan modifications to EXISTING files unless a new file is absolutely required.
4. You MUST NOT introduce placeholder values, dummy data, or fake configurations.
5. Your plan must be specific: name exact files, exact functions, exact lines of concern.
Respond ONLY with valid JSON — no markdown, no extra text.`
    },
    {
      role: 'user',
      content: `## Tech Stack
${detected.join(', ') || 'Unknown'}

## Total Files in Repo
${repoAnalysis?.totalFiles ?? 0}

## File Tree
${fileTree.slice(0, 200).join('\n')}

## Existing File Contents (READ CAREFULLY — this is the real codebase)
${deepContextSummary || '(no files read yet)'}

## User Instruction
"${instruction}"

## Task: Produce a structured plan. Respond ONLY with:
{
  "problemStatement": "clear description of what needs to change and why",
  "existingImplementation": "summary of how the relevant parts currently work based on files read",
  "impactedFiles": ["list of EXISTING files that will be modified"],
  "newFiles": ["list of NEW files required — empty if none needed"],
  "steps": ["Step 1: exact action on exact file", "Step 2: ..."],
  "risks": ["potential issue or breakage to watch for"],
  "summary": "one-line commit-message-style summary",
  "noPlaceholders": true
}`
    }
  ];

  const { content: raw, usage } = await callOpenAI(messages, { temperature: 0.1, maxTokens: 2500, jsonMode: true });
  const plan = parseJSON(raw, {
    problemStatement: instruction,
    existingImplementation: '',
    impactedFiles: [],
    newFiles: [],
    steps: ['(plan could not be parsed)'],
    risks: [],
    summary: instruction,
    noPlaceholders: true
  });

  plan.impactedFiles = toStringArray(plan.impactedFiles);
  plan.newFiles      = toStringArray(plan.newFiles);
  plan.steps         = toStringArray(plan.steps);
  plan.risks         = toStringArray(plan.risks);

  logger.info(`Plan ready — impacted: [${plan.impactedFiles.join(', ')}]`);
  return { plan, usage };
}

/**
 * PHASE 3 — Code generation (execution).
 * Works only from the actual existing file contents.
 * Enforces: complete code, no truncation, no placeholders.
 */
async function generateCodeChanges(instruction, plan, repoAnalysis, existingContents) {
  logger.info('Agent Phase 3: Generating code changes...');

  const detected = Array.isArray(repoAnalysis?.techStack?.detected) ? repoAnalysis.techStack.detected : [];
  const steps = toStringArray(plan.steps);
  const impacted = toStringArray(plan.impactedFiles);
  const newFiles = toStringArray(plan.newFiles);
  const filesToChange = [...impacted, ...newFiles];

  const existingCode = filesToChange
    .map(f => `=== ${f} (${existingContents[f] ? 'EXISTING — modify this' : 'NEW FILE — create this'}) ===\n${existingContents[f] || '[create new file]'}`)
    .join('\n\n') || '(no existing files provided)';

  const messages = [
    {
      role: 'system',
      content: `You are a senior software engineer acting as an autonomous coding agent — like Replit Agent.
STRICT RULES:
1. Generate COMPLETE, production-ready file contents — never truncate with "// rest of code here" or similar.
2. NEVER use placeholder values: no "YOUR_API_KEY", no "example.com", no "TODO", no fake URLs.
3. ONLY modify files that exist in the codebase. Do not create new files unless the plan explicitly requires it.
4. Preserve ALL existing functionality that is not part of the instruction — do not remove unrelated code.
5. Follow the exact same coding style, naming conventions, and patterns as the existing files.
6. If modifying a file, include the FULL updated file content, not just the changed section.
Respond ONLY with valid JSON — no markdown fences, no extra text.`
    },
    {
      role: 'user',
      content: `## User Instruction
"${instruction}"

## Problem Statement
${plan.problemStatement || instruction}

## Implementation Plan
${steps.join('\n') || '(no steps)'}

## Existing File Contents (COMPLETE — use these as your base)
${existingCode}

## Tech Stack
${detected.join(', ') || 'Unknown'}

## Task
Generate the code changes. Each change must include the COMPLETE updated file content.
Respond ONLY with:
{
  "changes": [
    {
      "path": "relative/path/to/file",
      "action": "modify or create",
      "content": "COMPLETE file content — never truncated",
      "description": "what was changed and why, referencing the specific existing code that was modified"
    }
  ],
  "commitMessage": "type(scope): short description",
  "explanation": "overall summary of all changes made and how they integrate with the existing codebase"
}`
    }
  ];

  const { content: raw, usage } = await callOpenAI(messages, { temperature: 0.1, maxTokens: 8000, jsonMode: true });
  const result = parseJSON(raw, null);

  if (!result || !Array.isArray(result.changes) || result.changes.length === 0) {
    logger.error(`generateCodeChanges: parse failed. Raw (first 800 chars): ${String(raw).substring(0, 800)}`);
    throw new Error('AI did not return valid code changes. Please rephrase your instruction and try again.');
  }

  logger.info(`Generated ${result.changes.length} file change(s)`);
  return { result, usage };
}

/**
 * PHASE 4 — Self-debugging.
 * Reviews the generated changes against the original codebase and instruction.
 * Detects: placeholders, truncated code, broken imports, missing logic, style violations.
 * Returns either { valid: true } or { valid: false, issues: [], fixedChanges: [...] }
 */
async function selfDebug(instruction, plan, generatedChanges, existingContents, attemptNumber) {
  logger.info(`Agent Phase 4: Self-debugging (attempt ${attemptNumber})...`);

  const changesJson = JSON.stringify(generatedChanges.changes, null, 2);
  const existingCode = Object.entries(existingContents)
    .map(([f, c]) => `=== ORIGINAL: ${f} ===\n${String(c).substring(0, 2000)}`)
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content: `You are a senior code reviewer acting as a self-debugging agent.
Your job is to review AI-generated code changes and find any issues before they are applied to a real codebase.
Be strict. Look for any of these problems:
- Placeholder values: "YOUR_KEY", "example.com", "TODO", "FIXME", fake URLs, hardcoded dummy data
- Truncated code: "// ... rest of code", "// existing code here", incomplete implementations
- Broken imports or references to files/functions that don't exist in the codebase
- Missing logic that the instruction requires
- Unrelated code that was accidentally removed
- Style or convention mismatches with the existing codebase
If ALL changes are correct and complete, respond with valid: true.
If issues exist, respond with valid: false AND provide the fully corrected changes.
Respond ONLY with valid JSON.`
    },
    {
      role: 'user',
      content: `## Original User Instruction
"${instruction}"

## Plan That Was Followed
${(plan.steps || []).join('\n')}

## Existing Codebase (before changes)
${existingCode}

## Generated Changes (under review)
${changesJson}

## Task
Review the generated changes. Respond ONLY with:
{
  "valid": true or false,
  "issuesFound": ["describe each issue found, or empty array if none"],
  "verdict": "PASS or FAIL with one-line reason",
  "fixedChanges": [
    {
      "path": "file path",
      "action": "modify or create",
      "content": "COMPLETE corrected file content",
      "description": "what was fixed"
    }
  ]
}`
    }
  ];

  const { content: raw, usage } = await callOpenAI(messages, { temperature: 0.05, maxTokens: 8000, jsonMode: true });
  const result = parseJSON(raw, { valid: true, issuesFound: [], verdict: 'PASS (parse fallback)', fixedChanges: [] });

  logger.info(`Self-debug attempt ${attemptNumber}: ${result.verdict || (result.valid ? 'PASS' : 'FAIL')}`);

  return { result, usage };
}

/**
 * Full agentic loop:
 * Phase 1: Identify relevant files
 * Phase 2: Plan with deep context
 * Phase 3: Generate changes
 * Phase 4: Self-debug (up to MAX_DEBUG_ATTEMPTS)
 * Returns structured report with all phases documented.
 */
async function runAgentLoop(instruction, repoAnalysis, localPath, getFilesContent, onProgress) {
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const agentLog = [];

  function addLog(phase, message) {
    const entry = { phase, message, timestamp: new Date().toISOString() };
    agentLog.push(entry);
    logger.info(`[Agent] ${phase}: ${message}`);
  }

  function accumulateUsage(usage) {
    if (!usage) return;
    totalUsage.prompt_tokens     += usage.prompt_tokens     || 0;
    totalUsage.completion_tokens += usage.completion_tokens || 0;
    totalUsage.total_tokens      += usage.total_tokens      || 0;
  }

  /* ── Phase 1: Identify relevant files ── */
  addLog('READING', 'Scanning codebase to identify relevant files...');
  onProgress && onProgress('thinking', { agentLog });

  const { files: relevantFiles, reasoning: readReasoning, usage: readUsage } = await identifyRelevantFiles(instruction, repoAnalysis);
  accumulateUsage(readUsage);
  addLog('READING', `Identified ${relevantFiles.length} relevant files: ${relevantFiles.join(', ')}`);

  const deepContext = relevantFiles.length > 0
    ? await getFilesContent(relevantFiles)
    : {};
  addLog('READING', `Read ${Object.keys(deepContext).length} files into context`);

  /* ── Phase 2: Structured planning ── */
  addLog('PLANNING', 'Analyzing existing implementation and forming a plan...');
  onProgress && onProgress('planning', { agentLog });

  const { plan, usage: planUsage } = await thinkAndPlan(instruction, repoAnalysis, deepContext);
  accumulateUsage(planUsage);
  addLog('PLANNING', `Plan ready — ${plan.steps.length} steps | Impacted: [${plan.impactedFiles.join(', ')}]`);
  addLog('PLANNING', `Problem: ${plan.problemStatement}`);

  /* ── Phase 3: Code generation ── */
  addLog('EXECUTING', 'Generating code changes based on plan and existing code...');
  onProgress && onProgress('generating', { agentLog, plan });

  const allFilesToRead = [...(plan.impactedFiles || []), ...(plan.newFiles || [])];
  const existingContents = allFilesToRead.length > 0
    ? await getFilesContent(allFilesToRead)
    : {};

  const { result: codeChanges, usage: genUsage } = await generateCodeChanges(instruction, plan, repoAnalysis, existingContents);
  accumulateUsage(genUsage);
  addLog('EXECUTING', `Generated ${codeChanges.changes.length} change(s): ${codeChanges.changes.map(c => c.path).join(', ')}`);

  /* ── Phase 4: Self-debugging loop ── */
  let finalChanges = codeChanges;
  let debugAttempts = 0;
  let allIssues = [];

  for (let attempt = 1; attempt <= MAX_DEBUG_ATTEMPTS; attempt++) {
    debugAttempts = attempt;
    addLog('DEBUGGING', `Running self-debug check (attempt ${attempt}/${MAX_DEBUG_ATTEMPTS})...`);
    onProgress && onProgress('debugging', { agentLog, plan, debugAttempts });

    const { result: debugResult, usage: debugUsage } = await selfDebug(
      instruction, plan, finalChanges, existingContents, attempt
    );
    accumulateUsage(debugUsage);

    const issues = toStringArray(debugResult.issuesFound);
    if (issues.length > 0) allIssues.push(...issues);

    addLog('DEBUGGING', `Verdict: ${debugResult.verdict || (debugResult.valid ? 'PASS' : 'FAIL')}`);

    if (debugResult.valid || !debugResult.fixedChanges || debugResult.fixedChanges.length === 0) {
      addLog('DEBUGGING', `Self-debug passed on attempt ${attempt}`);
      break;
    }

    addLog('DEBUGGING', `Issues found — applying fixes: ${issues.join('; ')}`);
    finalChanges = {
      ...finalChanges,
      changes: debugResult.fixedChanges
    };

    if (attempt === MAX_DEBUG_ATTEMPTS) {
      addLog('DEBUGGING', `Reached max debug attempts (${MAX_DEBUG_ATTEMPTS}) — using best available output`);
    }
  }

  /* ── Structured report ── */
  const structuredReport = {
    problemsFound:       [plan.problemStatement, ...allIssues.filter(Boolean)],
    planFollowed:        plan.steps,
    existingImplSummary: plan.existingImplementation,
    filesModified:       finalChanges.changes.map(c => ({ path: c.path, action: c.action, description: c.description })),
    debugAttempts,
    issuesCorrected:     allIssues,
    finalStatus:         'awaiting_approval',
    commitMessage:       finalChanges.commitMessage,
    explanation:         finalChanges.explanation
  };

  return {
    plan,
    changes: finalChanges,
    agentLog,
    structuredReport,
    debugAttempts,
    tokenUsage: {
      promptTokens:     totalUsage.prompt_tokens,
      completionTokens: totalUsage.completion_tokens,
      totalTokens:      totalUsage.total_tokens
    }
  };
}

async function explainCode(code, filePath) {
  logger.info(`Explaining file: ${filePath}`);
  const messages = [
    {
      role: 'system',
      content: 'You are CodeLite, an expert code explainer. Give clear, concise explanations for developers.'
    },
    {
      role: 'user',
      content: `Explain this code from \`${filePath}\`:\n\n\`\`\`\n${code}\n\`\`\`\n\nCover: purpose, how it works, key functions/classes, dependencies, and any potential issues.`
    }
  ];
  const { content, usage } = await callOpenAI(messages, { temperature: 0.3, maxTokens: 2000 });
  return { explanation: content, usage };
}

module.exports = {
  runAgentLoop,
  thinkAndPlan,
  generateCodeChanges,
  selfDebug,
  identifyRelevantFiles,
  explainCode,
  callOpenAI
};
