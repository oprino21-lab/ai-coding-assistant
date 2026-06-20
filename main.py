from openai import OpenAI

client = OpenAI()

with open("main.py", "r") as file:
    code = file.read()

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {
            "role": "system",
            "content": "You are a code expert. Find bugs and explain simply."
        },
        {
            "role": "user",
            "content": code
        }
    ]
)

print(response.choices[0].message.content)
