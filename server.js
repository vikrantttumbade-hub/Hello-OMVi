const { createServer } = require("http");
const { Server } = require("socket.io");

const httpServer = createServer();

const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

let waitingUser = null;

function matchUsers(first, second) {
  first.partner = second;
  second.partner = first;
  first.emit("matched");
  second.emit("matched");
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  if (waitingUser) {
    matchUsers(socket, waitingUser);
    waitingUser = null;
  } else {
    waitingUser = socket;
    socket.emit("waiting");
  }

  socket.on("message", (message) => {
    if (socket.partner) {
      socket.partner.emit("message", message);
    }
  });

  socket.on("typing", () => {
    if (socket.partner) {
      socket.partner.emit("typing");
    }
  });

  socket.on("video-call-start", () => {
    if (socket.partner) {
      socket.partner.emit("video-call-start");
    }
  });

  socket.on("offer", (offer) => {
    if (socket.partner) {
      socket.partner.emit("offer", offer);
    }
  });

  socket.on("answer", (answer) => {
    if (socket.partner) {
      socket.partner.emit("answer", answer);
    }
  });

  socket.on("ice-candidate", (candidate) => {
    if (socket.partner) {
      socket.partner.emit("ice-candidate", candidate);
    }
  });

  socket.on("video-call-stop", () => {
    if (socket.partner) {
      socket.partner.emit("video-call-stop");
    }
  });

  socket.on("search-again", () => {
    if (socket.partner) {
      return;
    }

    if (waitingUser && waitingUser !== socket) {
      matchUsers(socket, waitingUser);
      waitingUser = null;
    } else {
      waitingUser = socket;
      socket.emit("waiting");
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    if (waitingUser === socket) {
      waitingUser = null;
    }

    if (socket.partner) {
      socket.partner.emit("partner-disconnected");
      socket.partner.partner = null;
    }
  });
});

httpServer.listen(3001, () => {
  console.log("Socket server running on port 3001");
});
