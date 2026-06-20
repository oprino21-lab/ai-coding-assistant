import React, { useState } from 'react';
import ChatInterface from './components/ChatInterface';
import Sidebar from './components/Sidebar';
import './styles/App.css';

const App = () => {
  const [chats, setChats] = useState([]);
  const [repositories, setRepositories] = useState([]);

  const handleNewChat = () => {
    // Logic to create a new chat
  };

  const handleChatSelect = (chat) => {
    // Logic to select a chat
  };

  return (
    <div className='app'>
      <Sidebar chats={chats} onNewChat={handleNewChat} onChatSelect={handleChatSelect} repositories={repositories} />
      <ChatInterface />
    </div>
  );
};

export default App;
