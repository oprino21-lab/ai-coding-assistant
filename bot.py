import os
import requests
import time
import logging
from threading import Thread
from flask import Flask
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from github import Github

# ===== SETUP =====
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)
logger = logging.getLogger(__name__)

# ===== FLASK WEB SERVER =====
flask_app = Flask(__name__)

@flask_app.route('/')
def home():
    return "🤖 AI Coding Assistant is running!"

@flask_app.route('/health')
def health():
    return "OK", 200

def run_web_server():
    port = int(os.environ.get('PORT', 10000))
    flask_app.run(host='0.0.0.0', port=port)

# ===== READ KEYS =====
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
REPO_NAME = os.getenv("REPO_NAME", "oprino21-lab/ai-coding-assistant")

# ===== AI FUNCTION - USING openrouter/free =====
def ask_ai(prompt):
    """Send prompt to OpenRouter using the free model router."""
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ai-coding-assistant-eup4.onrender.com",
        "X-Title": "AI Coding Assistant"
    }
    
    data = {
        "model": "openrouter/free",  # ← CHANGED to the free router
        "messages": [
            {"role": "system", "content": "You are a coding assistant. Write clean, working code. Provide only the code without explanations."},
            {"role": "user", "content": prompt}
        ],
        "max_tokens": 2000,
        "temperature": 0.3
    }
    
    try:
        logger.info("📤 Sending request to OpenRouter...")
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
        logger.info(f"📥 Response received")
        
        if "error" in result:
            error_msg = result["error"].get("message", "Unknown API error")
            logger.error(f"❌ API Error: {error_msg}")
            raise Exception(f"OpenRouter API Error: {error_msg}")
        
        if "choices" not in result or len(result["choices"]) == 0:
            logger.error(f"❌ Unexpected response: {result}")
            raise Exception("No response from AI model. The free model might be temporarily unavailable.")
        
        content = result["choices"][0]["message"]["content"]
        logger.info(f"✅ AI Response received ({len(content)} characters)")
        return content
        
    except requests.exceptions.Timeout:
        raise Exception("Request timed out. The AI took too long to respond.")
    except requests.exceptions.RequestException as e:
        raise Exception(f"Network Error: {str(e)}")
    except KeyError as e:
        raise Exception("Unexpected API response. Please check your OpenRouter API key.")
    except Exception as e:
        raise e

# ===== GITHUB FUNCTION =====
def create_github_pr(instruction, ai_code):
    try:
        logger.info("🔗 Connecting to GitHub...")
        g = Github(GITHUB_TOKEN)
        repo = g.get_repo(REPO_NAME)
        
        main_branch = repo.get_branch("main")
        branch_name = f"ai-feature-{int(time.time())}"
        repo.create_git_ref(f"refs/heads/{branch_name}", main_branch.commit.sha)
        
        repo.create_file(
            "ai-generated-code.txt",
            f"🤖 AI: {instruction[:50]}",
            ai_code,
            branch=branch_name
        )
        
        pr = repo.create_pull(
            title=f"🤖 AI: {instruction[:50]}",
            body=f"## 🤖 AI Generated Code\n\n**Task:** {instruction}\n\n⚠️ Please review before merging.",
            head=branch_name,
            base="main"
        )
        
        logger.info(f"✅ PR created: {pr.html_url}")
        return pr.html_url
    except Exception as e:
        raise Exception(f"GitHub Error: {str(e)}")

# ===== TELEGRAM HANDLERS =====
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🤖 **AI Coding Assistant Ready!**\n\n"
        "Send me any coding task.\n\n"
        "📝 **Try:** `Write a Python function that adds two numbers`",
        parse_mode="Markdown"
    )

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_message = update.message.text
    processing_msg = await update.message.reply_text("⏳ Processing... This takes 30-60 seconds")
    
    try:
        ai_response = ask_ai(f"Write code for this task: {user_message}")
        pr_url = create_github_pr(user_message, ai_response)
        
        await processing_msg.delete()
        await update.message.reply_text(
            f"✅ **Done! Pull Request created:**\n{pr_url}\n\n"
            "📱 Open GitHub app to review and merge.",
            parse_mode="Markdown"
        )
    except Exception as e:
        await processing_msg.delete()
        error_msg = str(e)
        logger.error(f"❌ Error: {error_msg}")
        
        if "API" in error_msg:
            await update.message.reply_text(
                f"❌ **API Error:**\n{error_msg}\n\n"
                "💡 **Try again later.** The free models might be busy.",
                parse_mode="Markdown"
            )
        else:
            await update.message.reply_text(f"❌ **Error:** {error_msg}", parse_mode="Markdown")

async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        f"🟢 **Bot Status: Online**\n\n"
        f"📁 **Repository:** {REPO_NAME}\n"
        "🤖 **AI Model:** openrouter/free\n"
        "📊 **Free Tier:** 50 requests/day",
        parse_mode="Markdown"
    )

# ===== START BOT =====
if __name__ == "__main__":
    logger.info("🤖 Starting AI Coding Assistant...")
    
    # Start web server thread
    web_thread = Thread(target=run_web_server, daemon=True)
    web_thread.start()
    logger.info("🌐 Web server started")
    
    # Start Telegram bot
    telegram_app = Application.builder().token(TELEGRAM_TOKEN).build()
    telegram_app.add_handler(CommandHandler("start", start))
    telegram_app.add_handler(CommandHandler("status", status_command))
    telegram_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    
    logger.info("🚀 Bot is running!")
    print("🤖 Bot is running! Open Telegram and send a message.")
    telegram_app.run_polling()
