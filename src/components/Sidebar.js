import React from 'react';
import './Sidebar.css';

const Sidebar = ({ chats, onChatSelect, onNewChat, repositories }) => {
  return (
    <div className='sidebar'>
      <button onClick={onNewChat}>New Chat</button>
      <div className='chat-history'>
        {chats.map((chat, index) => (
          <div key={index} onClick={() => onChatSelect(chat)} className='chat-item'>
            {chat.title}
          </div>
        ))}
      </div>
      <div className='repositories'>
        <h3>Connected Repositories</h3>
        {repositories.map((repo, index) => (
          <div key={index} className='repo-item'>{repo.name}</div>
        ))}
      </div>
    </div>
  );
};

export default Sidebar;
