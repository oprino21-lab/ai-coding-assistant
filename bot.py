import os
import time
import logging
from threading import Thread
from flask import Flask
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from github import Github
from openai import OpenAI
import openai

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
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
REPO_NAME = os.getenv("REPO_NAME", "oprino21-lab/ai-coding-assistant")

# ===== CHECK IF KEYS ARE SET =====
if not TELEGRAM_TOKEN:
    logger.error("❌ TELEGRAM_TOKEN is not set in environment variables!")
if not OPENAI_API_KEY:
    logger.error("❌ OPENAI_API_KEY is not set in environment variables!")
if not GITHUB_TOKEN:
    logger.error("❌ GITHUB_TOKEN is not set in environment variables!")

# ===== INITIALIZE OPENAI =====
client = OpenAI(api_key=OPENAI_API_KEY)

# ===== AI FUNCTION WITH CLEAR ERROR HANDLING =====
def ask_ai(prompt):
    """Use OpenAI to write code."""
    try:
        logger.info(f"📤 Sending request to OpenAI...")
        
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a coding assistant. Write clean, working code. Provide only the code without explanations."},
                {"role": "user", "content": f"Write code for this task: {prompt}"}
            ],
            max_tokens=2000,
            temperature=0.3
        )
        
        content = response.choices[0].message.content
        logger.info(f"✅ OpenAI response received ({len(content)} characters)")
        return content
        
    except openai.AuthenticationError as e:
        logger.error(f"❌ OpenAI Authentication Error: {str(e)}")
        raise Exception("🔑 **OpenAI Authentication Error:** Your API key is invalid or expired. Please check your OpenAI API key at https://platform.openai.com/api-keys")
        
    except openai.RateLimitError as e:
        logger.error(f"❌ OpenAI Rate Limit Error: {str(e)}")
        raise Exception("⏳ **OpenAI Rate Limit Error:** You have exceeded your free tier limits. You can:\n1. Wait and try again later\n2. Add billing information at https://platform.openai.com/billing\n3. Check your usage at https://platform.openai.com/usage")
        
    except openai.APIStatusError as e:
        logger.error(f"❌ OpenAI API Status Error: {str(e)}")
        if "insufficient_quota" in str(e).lower():
            raise Exception("💰 **OpenAI Insufficient Quota:** Your free credits may have expired. Please check your billing at https://platform.openai.com/billing")
        elif "billing" in str(e).lower():
            raise Exception("💳 **OpenAI Billing Error:** Please add a payment method at https://platform.openai.com/billing")
        else:
            raise Exception(f"❌ **OpenAI API Error:** {str(e)}")
            
    except Exception as e:
        logger.error(f"❌ OpenAI General Error: {str(e)}")
        raise Exception(f"❌ **OpenAI Error:** {str(e)}")

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
        
    except github.GithubException as e:
        logger.error(f"❌ GitHub Error: {str(e)}")
        if e.status == 401:
            raise Exception("🔑 **GitHub Authentication Error:** Your GitHub token is invalid. Please generate a new token at https://github.com/settings/tokens")
        elif e.status == 404:
            raise Exception(f"📁 **GitHub Repository Not Found:** Repo '{REPO_NAME}' does not exist or you don't have access. Check your repository name.")
        elif e.status == 403:
            raise Exception("🚫 **GitHub Permission Error:** Your token doesn't have write access. Make sure 'repo' permissions are enabled.")
        else:
            raise Exception(f"❌ **GitHub Error:** {str(e)}")
            
    except Exception as e:
        logger.error(f"❌ GitHub General Error: {str(e)}")
        raise Exception(f"❌ **GitHub Error:** {str(e)}")

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
            f"{error_msg}\n\n"
            "💡 Check Render logs for more details.",
            parse_mode="Markdown"
        )

async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        f"🟢 **Bot Status: Online**\n\n"
        f"📁 **Repository:** {REPO_NAME}\n"
        "🤖 **AI Model:** OpenAI gpt-4o-mini\n"
        "📊 **API Keys:**\n"
        f"  • Telegram: {'✅ Set' if TELEGRAM_TOKEN else '❌ Missing'}\n"
        f"  • OpenAI: {'✅ Set' if OPENAI_API_KEY else '❌ Missing'}\n"
        f"  • GitHub: {'✅ Set' if GITHUB_TOKEN else '❌ Missing'}",
        parse_mode="Markdown"
    )

# ===== START BOT =====
if __name__ == "__main__":
    logger.info("🤖 Starting AI Coding Assistant...")
    
    web_thread = Thread(target=run_web_server, daemon=True)
    web_thread.start()
    logger.info("🌐 Web server started")
    
    telegram_app = Application.builder().token(TELEGRAM_TOKEN).build()
    telegram_app.add_handler(CommandHandler("start", start))
    telegram_app.add_handler(CommandHandler("status", status_command))
    telegram_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    
    logger.info("🚀 Bot is running! Open Telegram and send a message.")
    print("🤖 Bot is running! Open Telegram and send a message.")
    telegram_app.run_polling()
