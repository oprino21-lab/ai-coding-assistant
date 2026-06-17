import os
import requests
import time
import logging
from threading import Thread
from flask import Flask
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from github import Github
import google.generativeai as genai

# ===== SETUP LOGGING =====
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
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
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
REPO_NAME = os.getenv("REPO_NAME", "oprino21-lab/ai-coding-assistant")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# ===== CONFIGURE GEMINI =====
genai.configure(api_key=GEMINI_API_KEY)

# ===== AI FUNCTION USING GEMINI =====
def ask_ai(prompt):
    """Use Gemini AI to write code."""
    try:
        logger.info(f"📤 Sending request to Gemini...")
        
        # Try only gemini-1.5-flash
        models_to_try = [
            "models/gemini-1.5-flash"
        ]
        
        for model_name in models_to_try:
            try:
                logger.info(f"🔄 Trying: {model_name}")
                model = genai.GenerativeModel(model_name)
                
                full_prompt = f"You are a coding assistant. Write clean, working code. Provide only the code without explanations.\n\nTask: {prompt}"
                
                response = model.generate_content(full_prompt)
                
                if response.text:
                    logger.info(f"✅ Success with {model_name}")
                    return response.text
                    
            except Exception as e:
                logger.warning(f"⚠️ {model_name} failed: {str(e)}")
                continue
        
        raise Exception("All Gemini models failed")
            
    except Exception as e:
        logger.error(f"❌ Gemini Error: {str(e)}")
        raise Exception(f"Gemini API Error: {str(e)}")
        
# ===== GITHUB FUNCTION =====
def create_github_pr(instruction, ai_code):
    try:
        logger.info(f"🔗 Connecting to GitHub...")
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
        logger.error(f"❌ GitHub Error: {str(e)}")
        raise

# ===== TELEGRAM HANDLERS =====
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🤖 **AI Coding Assistant Ready!**\n\n"
        "Send me any coding task and I'll create a GitHub PR.\n\n"
        "📝 **Try:** `Write a Python function that adds two numbers`",
        parse_mode="Markdown"
    )

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_message = update.message.text
    logger.info(f"📩 Received: {user_message[:50]}...")
    
    processing_msg = await update.message.reply_text("⏳ Processing... This takes 30-60 seconds")
    
    try:
        ai_response = ask_ai(f"Write code for this task: {user_message}")
        pr_url = create_github_pr(user_message, ai_response)
        
        await processing_msg.delete()
        await update.message.reply_text(
            f"✅ **Done! Pull Request created:**\n{pr_url}\n\n"
            "📱 Open GitHub to review and merge.",
            parse_mode="Markdown"
        )
        logger.info(f"✅ Success for: {user_message[:50]}...")
        
    except Exception as e:
        await processing_msg.delete()
        error_msg = str(e)
        logger.error(f"❌ Error: {error_msg}")
        await update.message.reply_text(
            f"❌ **Error:** {error_msg}\n\n"
            "💡 Check Render logs for details.",
            parse_mode="Markdown"
        )

# ===== START BOT =====
if __name__ == "__main__":
    logger.info("🤖 Starting AI Coding Assistant...")
    
    # Start web server
    web_thread = Thread(target=run_web_server, daemon=True)
    web_thread.start()
    logger.info("🌐 Web server started")
    
    # Start Telegram bot
    telegram_app = Application.builder().token(TELEGRAM_TOKEN).build()
    telegram_app.add_handler(CommandHandler("start", start))
    telegram_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    
    logger.info("🚀 Bot is running!")
    print("🤖 Bot is running! Open Telegram and send a message.")
    telegram_app.run_polling()
