// One daemon connection for every Oxroute tab on this origin.
const ports = new Set();
let stream;
let timer;

function connect() {
  stream?.close();
  stream = new EventSource("/api/events");
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(connect, 15000);
  };
  stream.addEventListener("heartbeat", alive);
  stream.onmessage = ({ data }) => {
    alive();
    for (const listener of ports) listener.postMessage(data);
  };
  alive();
}

onconnect = ({ ports: [port] }) => {
  ports.add(port);
  port.onmessage = ({ data }) => {
    if (data !== "close") return;
    ports.delete(port);
    port.close();
    if (!ports.size) {
      stream.close();
      stream = undefined;
      clearTimeout(timer);
    }
  };
  port.postMessage(JSON.stringify({ type: "sync" }));
  if (!stream) connect();
};
