// One daemon connection for every Oxroute tab on this origin.
const ports = new Set();
let stream;

onconnect = ({ ports: [port] }) => {
  ports.add(port);
  port.onmessage = ({ data }) => {
    if (data !== "close") return;
    ports.delete(port);
    port.close();
    if (!ports.size) {
      stream.close();
      stream = undefined;
    }
  };
  port.postMessage(JSON.stringify({ type: "sync" }));
  if (!stream) {
    stream = new EventSource("/api/events");
    stream.onmessage = ({ data }) => {
      for (const listener of ports) listener.postMessage(data);
    };
  }
};
