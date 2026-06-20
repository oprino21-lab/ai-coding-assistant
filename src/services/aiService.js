const axios = require('axios');
const logger = require('../utils/logger');

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';

async function callOpenRouter(messages, options = {}) {
  const {
    model = DEFAULT_MODEL,
    maxTokens = 4096,
    temperature = 0.2
  } = options;

  try {
    const response = await axios.post(
      OPENROUTER_API_URL,
      {
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://ai-coding-assistant-85u2.onrender.com',
          'X-Title': 'CodeLite AI',
          'Content-Type': 'application/json'
        },
        timeout: 120000
      }
    );

    return response.data.choices[0].message.content;

  } catch (error) {
    console.error('=== OPENROUTER ERROR ===');
    console.error('Status:', error.response?.status);
    console.error('Data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Message:', error.message);

    throw error;
  }
        }
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://ai-coding-assistant-85u2.onrender.com',
        'X-Title': 'CodeLite AI',
        'Content-Type': 'application/json'
      },
      timeout: 120000
    }
  );

  return response.data.choices[0].message.content;
}

async function thinkAndPlan(userInstruction, repoAnalysis) {
  logger.info('AI thinking and planning...');

  const fileList = repoAnalysis.fileTree.slice(0, 150).join('\n');
  const techStack = repoAnalysis.techStack.detected.join(', ') || 'Unknown';

  const keyFileSummary = Object.entries(repoAnalysis.keyContents || {})
    .map(([file, content]) => `=== ${file} ===\n${content.substring(0, 2000)}`)
    .join('\n\n');

  const planMessages = [
    {
      role: 'system',
      content: `You are CodeLite, an expert AI coding assistant. Your job is to deeply analyze a codebase and plan changes carefully before implementing them.

Always think step-by-step. First understand the full context, then identify what needs to change and why, then produce a precise, actionable plan.`
    },
    {
      role: 'user',
      content: `## Repository Analysis

**Tech Stack:** ${techStack}
**Total Files:** ${repoAnalysis.totalFiles}

**File Tree (first 150 files):**
${fileList}

**Key File Contents:**
${keyFileSummary}

---

## User Instruction
"${userInstruction}"

---

## Your Task

Think carefully and produce a structured plan:

1. **Understanding**: What is this codebase doing? What is the user asking for?
2. **Impact Analysis**: Which files will need to be created or modified?
3. **Step-by-step Plan**: List every step required to implement the request.
4. **Risks**: Any potential issues or edge cases to watch out for?

Respond in this exact JSON format:
{
  "understanding": "...",
  "impactedFiles": ["path/to/file1", "path/to/file2"],
  "newFiles": ["path/to/newfile"],
  "plan": ["Step 1: ...", "Step 2: ...", "Step 3: ..."],
  "risks": ["..."],
  "summary": "One-line summary of what will be done"
}`
    }
  ];

  const planRaw = await callOpenRouter(planMessages, { temperature: 0.1, maxTokens: 2000 });

  let plan;
  try {
    const jsonMatch = planRaw.match(/\{[\s\S]*\}/);
    plan = JSON.parse(jsonMatch ? jsonMatch[0] : planRaw);
  } catch (e) {
    plan = {
      understanding: planRaw,
      impactedFiles: [],
      newFiles: [],
      plan: ['AI plan could not be parsed as JSON'],
      risks: [],
      summary: userInstruction
    };
  }

  logger.info(`Plan complete. Impacted files: ${[...plan.impactedFiles, ...(plan.newFiles || [])].join(', ')}`);
  return plan;
}

async function generateCodeChanges(userInstruction, plan, repoAnalysis, existingContents) {
  logger.info('AI generating code changes...');

  const filesToChange = [...(plan.impactedFiles || []), ...(plan.newFiles || [])];

  const existingCode = filesToChange
    .map(f => `=== ${f} (${existingContents[f] ? 'existing' : 'new file'}) ===\n${existingContents[f] || '[create new file]'}`)
    .join('\n\n');

  const generateMessages = [
    {
      role: 'system',
      content: `You are CodeLite, an expert AI coding assistant. You generate precise, complete, production-ready code changes.

Rules:
- Always output complete file contents, never partial snippets
- Follow existing code style and conventions
- Write clean, well-commented code
- Never use placeholder comments like "// rest of code here"
- Output ONLY the JSON response, no extra text`
    },
    {
      role: 'user',
      content: `## User Instruction
"${userInstruction}"

## Implementation Plan
${plan.plan.join('\n')}

## Existing File Contents
${existingCode}

## Tech Stack
${repoAnalysis.techStack.detected.join(', ')}

---

Generate the complete code for ALL files that need to be changed or created.

Respond ONLY with this JSON format:
{
  "changes": [
    {
      "path": "relative/path/to/file",
      "action": "create" | "modify",
      "content": "complete file content here",
      "description": "what changed and why"
    }
  ],
  "commitMessage": "feat: descriptive commit message",
  "explanation": "Overall explanation of all changes made"
}`
    }
  ];

  const rawResponse = await callOpenRouter(generateMessages, { temperature: 0.15, maxTokens: 8000 });

  let result;
  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    result = JSON.parse(jsonMatch ? jsonMatch[0] : rawResponse);
  } catch (e) {
    logger.error('Failed to parse AI code generation response', e);
    throw new Error('AI response could not be parsed. Please try again.');
  }

  logger.info(`Generated ${result.changes?.length || 0} file change(s)`);
  return result;
}

async function explainCode(code, filePath) {
  logger.info(`Explaining code: ${filePath}`);
  const messages = [
    {
      role: 'system',
      content: 'You are CodeLite, an expert code explainer. Provide clear, concise explanations suitable for developers.'
    },
    {
      role: 'user',
      content: `Explain this code from \`${filePath}\`:\n\n\`\`\`\n${code}\n\`\`\`\n\nInclude: purpose, how it works, key functions/classes, dependencies, and any potential issues.`
    }
  ];
  return callOpenRouter(messages, { temperature: 0.3, maxTokens: 2000 });
}

module.exports = { thinkAndPlan, generateCodeChanges, explainCode, callOpenRouter };
