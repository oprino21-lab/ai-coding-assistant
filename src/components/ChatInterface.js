import React, { useState, useEffect } from 'react';
import './ChatInterface.css';

const ChatInterface = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    setMessages([...messages, { text: input, sender: 'user' }]);
    setInput('');
    setLoading(true);

    const response = await fetch('/api/ai/instruct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: input }),
    });
    const data = await response.json();
    setMessages((prev) => [...prev, { text: data.response, sender: 'ai' }]);
    setLoading(false);
  };

  return (
    <div className='chat-interface'>
      <div className='messages'>
        {messages.map((msg, index) => (
          <div key={index} className={msg.sender}>
            {msg.sender === 'ai' ? <div className='ai-message'>{msg.text}</div> : <div className='user-message'>{msg.text}</div>}
          </div>
        ))}
        {loading && <div className='loading'>AI is thinking...</div>}
      </div>
      <form onSubmit={handleSend} className='input-area'>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows='3'
          placeholder='Type your message...'
        />
        <button type='submit'>Send</button>
      </form>
    </div>
  );
};

export default ChatInterface;
