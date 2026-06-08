import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// The app routes off the URL hash (wouter useHashLocation). Visitors who land
// on a real pathname (e.g. the public /track-record link shared on Twitter)
// have no hash yet, so seed it from the pathname before the router mounts.
if (!window.location.hash) {
  const path = window.location.pathname;
  window.location.hash = path && path !== "/" ? "#" + path : "#/";
}

createRoot(document.getElementById("root")!).render(<App />);
