from openai import OpenAI

client = OpenAI()

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {
            "role": "system",
            "content": "You are a coding assistant. Always analyze code and explain bugs clearly."
        },
        {
            "role": "user",
            "content": "Check my system and find issues."
        }
    ]
)

print(response.choices[0].message.content)
