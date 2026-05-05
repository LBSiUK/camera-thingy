const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10 * 1024 * 1024 });

const IMG_PATH = path.join(__dirname, 'img', 'IMG_4389.jpeg');

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log('Mobile client connected:', socket.id);

  socket.on('frame', (data) => {
    // data is a base64 data URL: "data:image/jpeg;base64,..."
    const base64 = data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    fs.writeFile(IMG_PATH, buffer, (err) => {
      if (err) console.error('Failed to save frame:', err);
      else console.log('Frame saved to img/IMG_4389.jpeg');
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Access from mobile on same network using your local IP');
});
