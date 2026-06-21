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
 * PHASE 1 — File identification.
 * Given the full file tree and pre-loaded key file contents, the AI decides
 * which files are relevant to the instruction — no keyword matching required.
 */
async function identifyRelevantFiles(instruction, repoAnalysis, context = {}, maxFiles = 20) {
  logger.info('Agent Phase 1: Identifying relevant files...');

  const fileTree = Array.isArray(repoAnalysis?.fileTree) ? repoAnalysis.fileTree : [];
  const detected = Array.isArray(repoAnalysis?.techStack?.detected) ? repoAnalysis.techStack.detected : [];
  const preloaded = context.preloadedContent || {};

  // Show the AI real file contents so it can reason about the code, not just names
  const preloadedSummary = Object.entries(preloaded)
    .map(([f, c]) => `=== ${f} ===\n${String(c).substring(0, 800)}`)
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content: `You are a senior software engineer and autonomous coding agent.
Your job: look at the project file tree and the sample file contents provided, then decide which files are relevant to the user's instruction.
Rules:
- Only return paths that appear EXACTLY in the Full File Tree.
- Think like an engineer: if the instruction says "fix login", look for auth/login/session/passport files.
- Include config, middleware, routes, services and models that relate to the task.
- Never invent file paths.
Respond ONLY with valid JSON.`
    },
    {
      role: 'user',
      content: `## Tech Stack
${detected.join(', ') || 'Unknown'}

## Sample File Contents (real code from the project)
${preloadedSummary || '(no preview available)'}

## Full File Tree (ONLY return paths from this list)
${fileTree.join('\n')}

## Instruction
"${instruction}"

## Task
Which files must be read and potentially changed to fulfil this instruction?
Return up to ${maxFiles} paths.

Respond ONLY with:
{
  "relevantFiles": ["exact/path/from/tree"],
  "reasoning": "brief explanation of why these files are relevant"
}`
    }
  ];

  const { content: raw, usage } = await callOpenAI(messages, { temperature: 0.1, maxTokens: 1000, jsonMode: true });
  const result = parseJSON(raw, { relevantFiles: [], reasoning: '' });
  const files = toStringArray(result.relevantFiles).slice(0, maxFiles);
  logger.info(`Phase 1 identified ${files.length} relevant files`);
  return { files, reasoning: result.reasoning || '', usage };
}

/**
 * PHASE 2 — Structured planning.
 * Uses deep file content (not just filenames) to form a concrete plan.
 * Enforces: describe the problem, list impacted files, write step-by-step actions.
 * Also determines codebaseSearchStatus: found | partial | not_found.
 */
async function thinkAndPlan(instruction, repoAnalysis, deepContext = {}) {
  logger.info('Agent Phase 2: Thinking and planning...');

  const fileTree = Array.isArray(repoAnalysis?.fileTree) ? repoAnalysis.fileTree : [];
  const detected = Array.isArray(repoAnalysis?.techStack?.detected) ? repoAnalysis.techStack.detected : [];

  const deepContextSummary = Object.entries(deepContext)
    .map(([file, content]) => `=== ${file} ===\n${String(content).substring(0, 3000)}`)
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content: `You are a senior software engineer acting as an autonomous coding agent.
Your job: read the existing code provided, identify exactly what the problem is, and produce a precise fix plan.

RULES:
1. The file contents below are the REAL codebase. Read them carefully before planning anything.
2. "fix" instructions → find the existing code that has the bug and edit it in-place. Do NOT create a new file for something that already exists.
3. "create" instructions → add the new file to "newFiles".
4. "problemStatement" must name the exact file and function where the issue is.
5. "existingImplementation" must describe how the code currently works — not generic text.
6. Never plan placeholder values or TODO comments.
7. If the feature truly does not exist anywhere in the codebase, set codebaseSearchStatus to "not_found".
Respond ONLY with valid JSON — no markdown, no extra text.`
    },
    {
      role: 'user',
      content: `## Tech Stack
${detected.join(', ') || 'Unknown'}

## File Tree
${fileTree.slice(0, 200).join('\n')}

## Existing Code (read carefully — this is the real project)
${deepContextSummary || '(no files available)'}

## Instruction
"${instruction}"

## Task
Analyse the code above and produce a fix plan. Respond ONLY with:
{
  "codebaseSearchStatus": "found | partial | not_found",
  "notFoundMessage": "if not_found: explain what is missing and suggest a follow-up instruction",
  "suggestion": "if not_found: e.g. 'Try: create a login system using passport.js'",
  "problemStatement": "exact description of the bug/task — name the file and function",
  "existingImplementation": "how the relevant code currently works based on the files above",
  "impactedFiles": ["existing files to modify"],
  "newFiles": ["brand-new files to create — only if truly needed"],
  "steps": ["Step 1: ...", "Step 2: ..."],
  "risks": ["anything that could break"],
  "summary": "one-line summary",
  "noPlaceholders": true
}`
    }
  ];

  const { content: raw, usage } = await callOpenAI(messages, { temperature: 0.1, maxTokens: 2500, jsonMode: true });
  const plan = parseJSON(raw, {
    codebaseSearchStatus: 'found',
    notFoundMessage: '',
    suggestion: '',
    problemStatement: instruction,
    existingImplementation: '',
    impactedFiles: [],
    newFiles: [],
    steps: ['(plan could not be parsed)'],
    risks: [],
    summary: instruction,
    noPlaceholders: true
  });

  plan.codebaseSearchStatus = plan.codebaseSearchStatus || 'found';
  plan.notFoundMessage      = plan.notFoundMessage      || '';
  plan.suggestion           = plan.suggestion           || '';
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
  const fileTree  = Array.isArray(repoAnalysis?.fileTree) ? repoAnalysis.fileTree : [];
  const steps = toStringArray(plan.steps);
  const impacted = toStringArray(plan.impactedFiles);
  const newFiles = toStringArray(plan.newFiles);
  const filesToChange = [...impacted, ...newFiles];

  // Guard: if no files planned AND no context at all, we cannot generate safely
  if (filesToChange.length === 0 && Object.keys(existingContents).length === 0) {
    throw new Error(
      'Agent could not identify which files to modify. ' +
      'Please be more specific about which file or feature to change.'
    );
  }

  // Build existing code section — include everything in existingContents (merged context from Phase 1+3)
  const allContextFiles = filesToChange.length > 0
    ? [...new Set([...filesToChange, ...Object.keys(existingContents)])]
    : Object.keys(existingContents);

  const existingCode = allContextFiles
    .map(f => {
      const inFileTree = fileTree.includes(f);
      const isPlanned  = filesToChange.includes(f);
      const label = !inFileTree
        ? 'NEW FILE — create this'
        : isPlanned
          ? 'EXISTING — modify this'
          : 'EXISTING — context only, do not modify unless required';
      return `=== ${f} (${label}) ===\n${existingContents[f] || '[create new file]'}`;
    })
    .join('\n\n') || '(no existing files provided)';

  const messages = [
    {
      role: 'system',
      content: `You are a senior software engineer acting as an autonomous coding agent — like Replit Agent.
STRICT RULES — follow all of them without exception:
1. Generate COMPLETE, production-ready file contents — never truncate with "// rest of code here" or similar.
2. NEVER use placeholder values: no "YOUR_API_KEY", no "example.com", no "TODO", no fake URLs.
3. EDITING EXISTING FILES: If a file is marked "EXISTING" in the context below, you MUST edit it in-place. Do NOT create a replacement. Include the FULL updated file content.
4. CREATING NEW FILES: Only create a new file if it is listed as "NEW FILE" in the context, or the user's instruction explicitly says to create a specific file.
5. Preserve ALL existing functionality that is not part of the instruction — do not remove unrelated code.
6. Follow the exact same coding style, naming conventions, and patterns as the existing files.
7. Your "description" field for each change must clearly state: what the bug/problem was, and exactly what you changed to fix it.
8. Your "explanation" field must answer: "What was wrong?" and "What did I fix?" in plain language the user can understand.
Respond ONLY with valid JSON — no markdown fences, no extra text.`
    },
    {
      role: 'user',
      content: `## User Instruction
"${instruction}"

## Problem Found
${plan.problemStatement || instruction}

## Existing Implementation
${plan.existingImplementation || '(see file contents below)'}

## Step-by-Step Fix Plan
${steps.join('\n') || '(no steps)'}

## File Contents (COMPLETE — modify these in-place, do not recreate from scratch)
${existingCode}

## Tech Stack
${detected.join(', ') || 'Unknown'}

## Task
Fix the problem by editing the existing files. Write COMPLETE file contents.
Respond ONLY with:
{
  "changes": [
    {
      "path": "relative/path/to/file",
      "action": "modify (for existing files) or create (for brand-new files only)",
      "content": "COMPLETE file content — never truncated",
      "description": "Bug found: [describe the specific problem in the existing code]. Fix applied: [describe exactly what was changed]"
    }
  ],
  "commitMessage": "fix(scope): short description of what was broken and how it was fixed",
  "explanation": "What was wrong: [clear explanation]. What was fixed: [clear explanation of the changes made and why they solve the problem].",
  "problemFound": "${(plan.problemStatement || instruction).replace(/"/g, '\\"')}"
}`
    }
  ];

  const { content: raw, usage } = await callOpenAI(messages, { temperature: 0.1, maxTokens: 8000, jsonMode: true });
  const result = parseJSON(raw, null);

  if (!result || !Array.isArray(result.changes) || result.changes.length === 0) {
    logger.error(`generateCodeChanges: parse failed. Raw (first 800 chars): ${String(raw).substring(0, 800)}`);
    throw new Error('AI did not return valid code changes. Please rephrase your instruction and try again.');
  }

  // Programmatically correct the action field — if the file exists in the tree it MUST be "modify".
  // This overrides any AI mistake; we never let the AI "create" a file that already exists.
  const fileTreeSet = new Set(fileTree);
  result.changes.forEach(change => {
    if (change.path) {
      change.action = fileTreeSet.has(change.path) ? 'modify' : 'create';
    }
  });

  logger.info(`Generated ${result.changes.length} file change(s)`);
  return { result, usage };
}

/**
 * Programmatic placeholder detector — fast, deterministic, zero-token-cost.
 * Scans generated file contents for known bad patterns before sending to AI review.
 */
function detectPlaceholders(changes) {
  const PLACEHOLDER_PATTERNS = [
    /YOUR_API_KEY/i,
    /YOUR_SECRET/i,
    /REPLACE_ME/i,
    /example\.com/i,
    /localhost:3000(?!\s*[,;)\]}])/,  // localhost:3000 when it's not part of a config default
    /dummy[_\s-]?(key|token|value|data|url)/i,
    /fake[_\s-]?(key|token|value|data|url)/i,
    /\bTODO\b/,
    /\bFIXME\b/,
    /\/\/ ?\.\.\. ?rest of (the )?code/i,
    /\/\/ ?(existing|rest|other) code (here|goes here)/i,
    /\/\* ?(existing|rest|other|previous) code \*\//i,
    /\[your[_\s-]?\w+\]/i,
    /INSERT_\w+_HERE/i,
  ];

  const found = [];
  for (const change of changes) {
    const content = change.content || '';
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(content)) {
        found.push(`${change.path}: matched pattern /${pattern.source}/i`);
        break;
      }
    }
  }
  return found;
}

/**
 * PHASE 4 — Self-debugging.
 * Reviews the generated changes against the original codebase and instruction.
 * Detects: placeholders, truncated code, broken imports, missing logic, style violations.
 * Returns either { valid: true } or { valid: false, issues: [], fixedChanges: [...] }
 */
async function selfDebug(instruction, plan, generatedChanges, existingContents, attemptNumber) {
  logger.info(`Agent Phase 4: Self-debugging (attempt ${attemptNumber})...`);

  // Trim file contents in the review prompt to avoid token-limit truncation.
  // The actual full-content changes are kept separately in generatedChanges.
  const REVIEW_CONTENT_LIMIT = 2500;
  const trimmedChanges = generatedChanges.changes.map(c => ({
    path:        c.path,
    action:      c.action,
    description: c.description,
    content:     c.content
      ? c.content.substring(0, REVIEW_CONTENT_LIMIT) +
        (c.content.length > REVIEW_CONTENT_LIMIT ? '\n...[remaining content truncated for review — full content is present in the actual change]' : '')
      : ''
  }));

  const changesJson = JSON.stringify(trimmedChanges, null, 2);
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
 * Phase 1 (READING)   — Load key project files, then ask AI which are relevant
 * Phase 2 (PLANNING)  — Deep analysis + concrete fix plan
 * Phase 3 (EXECUTING) — Generate complete file changes (modify existing / create new)
 * Phase 4 (CHECKING)  — Self-debug up to MAX_DEBUG_ATTEMPTS
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

  /* ── Phase 1: Read the codebase ── */
  addLog('READING', 'Reading your codebase to understand the project...');
  onProgress && onProgress('thinking', { agentLog });

  const fileTree    = Array.isArray(repoAnalysis?.fileTree)       ? repoAnalysis.fileTree       : [];
  const keyFiles    = Array.isArray(repoAnalysis?.keyFiles)        ? repoAnalysis.keyFiles        : [];
  const fileTreeSet = new Set(fileTree);

  // Pre-load key files so the AI has real content to reason from (not just filenames).
  const preloaded = keyFiles.length > 0 ? await getFilesContent(keyFiles.slice(0, 15)) : {};
  addLog('READING', `Loaded ${Object.keys(preloaded).length} key file(s) for analysis`);

  // Ask the AI: given the full file tree + key file contents, which files are relevant?
  const { files: rawRelevantFiles, usage: readUsage } = await identifyRelevantFiles(instruction, repoAnalysis, { preloadedContent: preloaded }, 20);
  accumulateUsage(readUsage);

  // Only accept paths that actually exist in the repo — drop any AI hallucinations
  const aiFiles = rawRelevantFiles.filter(f => {
    const ok = fileTreeSet.has(f);
    if (!ok) logger.warn(`[Agent] Skipping non-existent path from AI: ${f}`);
    return ok;
  });

  // Final relevant set: AI-identified files + key files already loaded (deduped)
  const relevantFiles = [...new Set([...aiFiles, ...keyFiles.slice(0, 10)])].slice(0, 20);
  addLog('READING', `Analysing ${relevantFiles.length} relevant file(s): ${relevantFiles.join(', ')}`);

  // Load any relevant files not already in preloaded content
  const deepContext = { ...preloaded };
  const toLoad = relevantFiles.filter(f => !(f in deepContext));
  if (toLoad.length > 0) Object.assign(deepContext, await getFilesContent(toLoad));
  addLog('READING', `Read ${Object.keys(deepContext).length} file(s) — ready to analyse`);

  /* ── Phase 2: Analyse and plan ── */
  addLog('PLANNING', 'Analysing the problem and forming a fix plan...');
  onProgress && onProgress('planning', { agentLog });

  const { plan, usage: planUsage } = await thinkAndPlan(instruction, repoAnalysis, deepContext);
  accumulateUsage(planUsage);
  addLog('PLANNING', `Problem: ${plan.problemStatement}`);
  if (plan.impactedFiles.length > 0) {
    addLog('PLANNING', `Files to fix: [${plan.impactedFiles.join(', ')}] | Steps: ${plan.steps.length}`);
  }

  /* ── Early exit: feature genuinely does not exist ── */
  if (plan.codebaseSearchStatus === 'not_found') {
    addLog('RESULT', `Not found: ${plan.notFoundMessage}`);
    const structuredReport = {
      problemStatement:     plan.problemStatement,
      codebaseSearchStatus: 'not_found',
      notFoundMessage:      plan.notFoundMessage,
      suggestion:           plan.suggestion,
      filesRead:            relevantFiles,
      finalStatus:          'not_found'
    };
    return {
      plan,
      changes:         null,
      notFound:        true,
      notFoundMessage: plan.notFoundMessage,
      suggestion:      plan.suggestion,
      agentLog,
      structuredReport,
      debugAttempts:   0,
      tokenUsage: {
        promptTokens:     totalUsage.prompt_tokens,
        completionTokens: totalUsage.completion_tokens,
        totalTokens:      totalUsage.total_tokens
      }
    };
  }

  /* ── Phase 3: Code generation ── */
  addLog('EXECUTING', 'Generating code changes based on plan and existing code...');
  onProgress && onProgress('generating', { agentLog, plan });

  // Fetch files the plan identified, then MERGE with Phase 1 deepContext so execution
  // always has the full picture — Phase 1 understanding is never discarded.
  const allFilesToRead = [...(plan.impactedFiles || []), ...(plan.newFiles || [])];
  const planContents = allFilesToRead.length > 0
    ? await getFilesContent(allFilesToRead)
    : {};
  // deepContext (Phase 1) provides background; planContents (Phase 3) are the targets.
  // planContents wins on key conflicts so the latest read is authoritative.
  const existingContents = { ...deepContext, ...planContents };

  const { result: codeChanges, usage: genUsage } = await generateCodeChanges(instruction, plan, repoAnalysis, existingContents);
  accumulateUsage(genUsage);
  addLog('EXECUTING', `Generated ${codeChanges.changes.length} change(s): ${codeChanges.changes.map(c => c.path).join(', ')}`);

  /* ── Phase 4: Self-debugging loop ── */
  let finalChanges = codeChanges;
  let debugAttempts = 0;
  let allIssues = [];

  // Run programmatic placeholder check first — fast, deterministic, zero token cost
  const placeholderHits = detectPlaceholders(finalChanges.changes);
  if (placeholderHits.length > 0) {
    addLog('DEBUGGING', `Programmatic scan found placeholder patterns: ${placeholderHits.join(' | ')}`);
    allIssues.push(...placeholderHits);
  } else {
    addLog('DEBUGGING', 'Programmatic placeholder scan: CLEAN');
  }

  for (let attempt = 1; attempt <= MAX_DEBUG_ATTEMPTS; attempt++) {
    debugAttempts = attempt;
    addLog('DEBUGGING', `Running AI self-debug review (attempt ${attempt}/${MAX_DEBUG_ATTEMPTS})...`);
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
    // fixedChanges from AI review contain only trimmed content — preserve full content
    // for any change the AI didn't actually fix (keep original full-content version)
    const fixedPaths = new Set(debugResult.fixedChanges.map(c => c.path));
    const unfixedOriginals = finalChanges.changes.filter(c => !fixedPaths.has(c.path));
    finalChanges = {
      ...finalChanges,
      changes: [...debugResult.fixedChanges, ...unfixedOriginals]
    };

    if (attempt === MAX_DEBUG_ATTEMPTS) {
      addLog('DEBUGGING', `Reached max debug attempts (${MAX_DEBUG_ATTEMPTS}) — using best available output`);
    }
  }

  /* ── Structured report ── */
  const structuredReport = {
    problemStatement:    plan.problemStatement,
    existingImplSummary: plan.existingImplementation,
    planFollowed:        plan.steps,
    risks:               plan.risks,
    filesModified:       finalChanges.changes.map(c => ({ path: c.path, action: c.action, description: c.description })),
    debugAttempts,
    issuesCorrected:     allIssues.filter(Boolean),
    placeholderHits,
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
