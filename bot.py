import os
import requests
import time
import logging
from threading import Thread
from flask import Flask, render_template_string
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from github import Github

# ===== SETUP LOGGING =====
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# ===== CREATE FLASK APP FOR PORT BINDING =====
flask_app = Flask(__name__)

@flask_app.route('/')
def home():
    return "🤖 AI Coding Assistant is running!"

@flask_app.route('/health')
def health():
    return "OK", 200

def run_web_server():
    """Run Flask web server on port 10000 (Render expects this)"""
    port = int(os.environ.get('PORT', 10000))
    flask_app.run(host='0.0.0.0', port=port)

# ===== READ KEYS FROM ENVIRONMENT VARIABLES =====
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
REPO_NAME = os.getenv("REPO_NAME", "oprino21-lab/ai-coding-assistant")

# ===== VALIDATE KEYS =====
if not TELEGRAM_TOKEN:
    logger.error("❌ TELEGRAM_TOKEN is not set!")
if not OPENROUTER_API_KEY:
    logger.error("❌ OPENROUTER_API_KEY is not set!")
if not GITHUB_TOKEN:
    logger.error("❌ GITHUB_TOKEN is not set!")

# ===== AI FUNCTION =====
def ask_ai(prompt):
    """Send a prompt to OpenRouter AI and return the response."""
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ai-coding-assistant-eup4.onrender.com",
        "X-Title": "AI Coding Assistant"
    }
    
    data = {
        "model": "deepseek/deepseek-r1:free",
        "messages": [
            {
                "role": "system", 
                "content": "You are a coding assistant. Write clean, working code. Provide only the code without explanations unless asked."
            },
            {
                "role": "user", 
                "content": prompt
            }
        ],
        "max_tokens": 2000,
        "temperature": 0.3
    }
    
    try:
        logger.info(f"📤 Sending request to OpenRouter...")
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers=headers,
            json=data,
            timeout=90
        )
        
        if response.status_code != 200:
            logger.error(f"❌ HTTP Error: {response.status_code}")
            logger.error(f"Response: {response.text[:500]}")
            raise Exception(f"HTTP Error {response.status_code}: {response.text[:200]}")
        
        result = response.json()
        
        if "error" in result:
            error_msg = result["error"].get("message", "Unknown API error")
            logger.error(f"❌ API Error: {error_msg}")
            raise Exception(f"OpenRouter API Error: {error_msg}")
        
        if "choices" not in result or len(result["choices"]) == 0:
            logger.error(f"❌ Unexpected API Response: {result}")
            raise Exception("No response from AI model. The free model might be temporarily unavailable.")
        
        content = result["choices"][0]["message"]["content"]
        logger.info(f"✅ AI Response received ({len(content)} characters)")
        return content
        
    except requests.exceptions.Timeout:
        logger.error("❌ Request timed out")
        raise Exception("Request timed out. The AI took too long to respond.")
    except requests.exceptions.RequestException as e:
        logger.error(f"❌ Network Error: {str(e)}")
        raise Exception(f"Network Error: {str(e)}")
    except KeyError as e:
        logger.error(f"❌ KeyError: {str(e)}")
        raise Exception("Unexpected API response format. Please check your OpenRouter API key.")
    except Exception as e:
        logger.error(f"❌ Unexpected Error: {str(e)}")
        raise e

# ===== GITHUB FUNCTION =====
def create_github_pr(instruction, ai_code):
    """Create a new branch, commit the AI-generated code, and open a Pull Request."""
    try:
        logger.info(f"🔗 Connecting to GitHub...")
        g = Github(GITHUB_TOKEN)
        repo = g.get_repo(REPO_NAME)
        logger.info(f"✅ Connected to repository: {REPO_NAME}")
        
        main_branch = repo.get_branch("main")
        branch_name = f"ai-feature-{int(time.time())}"
        logger.info(f"🌿 Creating branch: {branch_name}")
        repo.create_git_ref(f"refs/heads/{branch_name}", main_branch.commit.sha)
        
        file_name = "ai-generated-code.txt"
        commit_message = f"🤖 AI: {instruction[:50]}"
        logger.info(f"📝 Creating file: {file_name}")
        repo.create_file(
            file_name,
            commit_message,
            ai_code,
            branch=branch_name
        )
        
        pr_title = f"🤖 AI: {instruction[:50]}"
        pr_body = f"## 🤖 AI Generated Code\n\n**Task:** {instruction}\n\n**Generated by:** AI Coding Assistant\n\n---\n\n⚠️ Please review the code before merging."
        logger.info(f"📬 Creating Pull Request...")
        pr = repo.create_pull(
            title=pr_title,
            body=pr_body,
            head=branch_name,
            base="main"
        )
        
        logger.info(f"✅ PR created: {pr.html_url}")
        return pr.html_url
        
    except Exception as e:
        logger.error(f"❌ GitHub Error: {str(e)}")
        raise Exception(f"GitHub Error: {str(e)}")

# ===== TELEGRAM HANDLERS =====
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start command"""
    await update.message.reply_text(
        "🤖 **AI Coding Assistant Ready!**\n\n"
        "I can write code and create GitHub Pull Requests for you.\n\n"
        "📝 **Try these:**\n"
        "• `Write a Python function that adds two numbers`\n"
        "• `Create a React component for a navbar`\n"
        "• `Add a login button to index.html`\n\n"
        "⚡ Just send me any coding task and I'll handle the rest!",
        parse_mode="Markdown"
    )

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle regular messages (coding tasks)"""
    user_message = update.message.text
    processing_msg = await update.message.reply_text("⏳ **Processing your request...**\n\nThis usually takes 30-60 seconds.", parse_mode="Markdown")
    
    try:
        logger.info(f"📩 Received: {user_message[:50]}...")
        await processing_msg.edit_text("📤 **Step 1/2:** Asking AI to write code...", parse_mode="Markdown")
        
        ai_response = ask_ai(f"Write code for this task: {user_message}")
        
        await processing_msg.edit_text("📤 **Step 2/2:** Creating GitHub Pull Request...", parse_mode="Markdown")
        pr_url = create_github_pr(user_message, ai_response)
        
        await processing_msg.delete()
        await update.message.reply_text(
            f"✅ **Done! Pull Request created:**\n{pr_url}\n\n"
            "📱 **Next Steps:**\n"
            "1. Open the link above\n"
            "2. Review the code on GitHub\n"
            "3. Click 'Merge' if everything looks good\n\n"
            "💡 The code is in your repository's main branch after merging.",
            parse_mode="Markdown",
            disable_web_page_preview=True
        )
        
        logger.info(f"✅ Successfully completed task for: {user_message[:50]}...")
        
    except Exception as e:
        await processing_msg.delete()
        error_msg = str(e)
        logger.error(f"❌ Error: {error_msg}")
        
        if "API" in error_msg or "OpenRouter" in error_msg:
            await update.message.reply_text(
                f"❌ **API Error:**\n{error_msg}\n\n"
                "💡 **Troubleshooting:**\n"
                "1. Check your OpenRouter API key at https://openrouter.ai/keys\n"
                "2. The free model might be temporarily down, try again in a few minutes\n"
                "3. You might have hit the rate limit (50 requests/day)",
                parse_mode="Markdown"
            )
        elif "GitHub" in error_msg:
            await update.message.reply_text(
                f"❌ **GitHub Error:**\n{error_msg}\n\n"
                "💡 **Troubleshooting:**\n"
                "1. Check your GitHub token at https://github.com/settings/tokens\n"
                "2. Ensure the token has 'repo' and 'workflow' permissions\n"
                "3. Verify the repository name is correct",
                parse_mode="Markdown"
            )
        else:
            await update.message.reply_text(
                f"❌ **Error:** {error_msg}\n\n"
                "💡 Try sending your request again.",
                parse_mode="Markdown"
            )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /help command"""
    await update.message.reply_text(
        "🤖 **Help Center**\n\n"
        "**Available Commands:**\n"
        "/start - Welcome message\n"
        "/help - Show this help\n"
        "/status - Check bot status\n\n"
        "**What I can do:**\n"
        "• Write Python, JavaScript, HTML, CSS, and more\n"
        "• Create GitHub Pull Requests automatically\n"
        "• Add features to your existing code\n"
        "• Fix bugs and errors\n\n"
        "**Example:** `Create a login form in HTML`",
        parse_mode="Markdown"
    )

async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /status command"""
    status_msg = (
        "🟢 **Bot Status: Online**\n\n"
        f"📁 **Repository:** {REPO_NAME}\n"
        "🤖 **AI Model:** DeepSeek R1 (free)\n"
        "🔐 **API Status:** Connected\n"
        "📊 **Free Tier:** 50 requests/day\n\n"
        "⚡ Ready for your coding tasks!"
    )
    await update.message.reply_text(status_msg, parse_mode="Markdown")

# ===== START BOT =====
if __name__ == "__main__":
    logger.info("🤖 Starting AI Coding Assistant...")
    
    try:
        # Start the web server in a separate thread
        web_thread = Thread(target=run_web_server, daemon=True)
        web_thread.start()
        logger.info("🌐 Web server started on port 10000")
        
        # Create Telegram application
        telegram_app = Application.builder().token(TELEGRAM_TOKEN).build()
        
        # Add command handlers
        telegram_app.add_handler(CommandHandler("start", start))
        telegram_app.add_handler(CommandHandler("help", help_command))
        telegram_app.add_handler(CommandHandler("status", status_command))
        
        # Add message handler for all other messages
        telegram_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
        
        logger.info("🚀 Bot is running! Open Telegram and send a message.")
        print("🤖 Bot is running! Open Telegram and send a message.")
        print("🌐 Web server running on port 10000")
        
        # Start the Telegram bot
        telegram_app.run_polling()
        
    except Exception as e:
        logger.error(f"❌ Failed to start bot: {str(e)}")
        print(f"❌ Failed to start bot: {str(e)}")
