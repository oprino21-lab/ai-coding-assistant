import openai
import os

client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

response = client.chat.completions.create(
  model="gpt-4",
  messages=[{"role": "user", "content": "Explain the current project structure."}]
)

print(response.choices[0].message.content)
