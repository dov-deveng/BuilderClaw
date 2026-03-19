/**
 * BuilderClaw — Agent Registry
 * Loads agent profiles, builds per-agent prompts with memory + skills + context.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAgent, getAgentMemorySummary, getAgentSkills, buildContractorContext, getRecentAgentMessages } from "../memory/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, "prompts");
const SKILLS_DIR = path.join(__dirname, "skills");

// Load a markdown prompt file for an agent
function loadPromptFile(filename) {
  if (!filename) return "";
  const filePath = path.join(PROMPTS_DIR, filename);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

// Load a skill's markdown instructions
function loadSkillFile(skillId) {
  const filePath = path.join(SKILLS_DIR, skillId + ".md");
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

// Build conversation history context (last few messages for continuity)
function buildConversationContext(agentId) {
  const recent = getRecentAgentMessages(agentId, 6);
  if (recent.length === 0) return "";

  const lines = recent.reverse().map(m => {
    const who = m.role === "user" ? "Contractor" : "You";
    return `${who}: ${m.content}`;
  });

  return "RECENT CONVERSATION (for context, do not repeat yourself):\n" + lines.join("\n");
}

/**
 * Build the complete prompt for an agent interaction.
 * Combines: agent identity + contractor context + memory + skills + conversation history + user message.
 */
export function buildAgentTask(agentId, userMessage, source = "chat") {
  const agent = getAgent(agentId);
  if (!agent) {
    if (agentId !== "claw") {
      return buildAgentTask("claw", userMessage, source);
    }
    // Claw missing from DB — use hardcoded fallback
    return `You are Claw, an AI back office assistant for construction contractors. Be direct and practical.\n\n---\nMessage from the contractor:\n${userMessage}`;
  }

  const parts = [];

  // 1. Agent identity (from markdown prompt file)
  const promptMarkdown = loadPromptFile(agent.prompt_file);
  if (promptMarkdown) {
    parts.push(promptMarkdown);
  } else {
    // Custom agent with no prompt file — use name and role as identity
    parts.push(`You are ${agent.name}, a specialized AI agent for a construction contractor.\nYour role: ${agent.role}\n\nBe direct, practical, and construction-savvy. No fluff.`);
  }

  // 2. Contractor context (company, projects, contacts)
  const contractorCtx = buildContractorContext();
  if (contractorCtx) {
    parts.push(contractorCtx);
  }

  // 3. Agent memory
  const memorySummary = getAgentMemorySummary(agentId);
  if (memorySummary) {
    parts.push(memorySummary);
  }

  // 4. Enabled skills
  const skills = getAgentSkills(agentId);
  if (skills.length > 0) {
    const skillInstructions = skills
      .map(s => loadSkillFile(s.skill_id))
      .filter(Boolean)
      .join("\n\n---\n\n");
    if (skillInstructions) {
      parts.push("CONNECTED INTEGRATIONS (you can use these tools):\n\n" + skillInstructions);
    }
  }

  // 5. Conversation history
  const convCtx = buildConversationContext(agentId);
  if (convCtx) {
    parts.push(convCtx);
  }

  // 6. Memory + file save instructions
  parts.push(`MEMORY INSTRUCTIONS:
If you learn something important to remember for future conversations (a project detail, a preference, a deadline, a contact), include at the end of your response:
[MEMORY:key_name=value to remember]
Example: [MEMORY:main_project=Highland Park renovation, 3-story, started March 2026]

DOCUMENT INSTRUCTIONS:
When you create a document, estimate, report, or any content worth saving, include it as:
[FILE:filename.ext]
...file content...
[/FILE]
Example: [FILE:rfi-001.txt]
RFI #001 - Electrical Panel Location
...
[/FILE]`);

  // 7. Response formatting
  if (source === "whatsapp") {
    parts.push("Keep responses SHORT — this is WhatsApp, not email. 2-4 sentences max for simple answers.");
  } else {
    parts.push("Keep responses concise and practical. Do NOT use markdown formatting (no **, no ##, no bullet points with -). Write in plain conversational text.");
  }

  // 8. User message
  const msgPrefix = source === "whatsapp" ? "WhatsApp message from the contractor" : "Message from the contractor";
  parts.push(`---\n${msgPrefix}:\n${userMessage}`);

  return parts.join("\n\n");
}
