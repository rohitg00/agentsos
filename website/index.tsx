import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import DocsLayout from "./components/docs/DocsLayout";
import DocsHome from "./components/docs/DocsHome";
import DocsPage from "./components/docs/DocsPage";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<App />} />
      <Route path="/docs" element={<DocsLayout />}>
        <Route index element={<DocsHome />} />
        <Route path=":slug" element={<DocsPage />} />
      </Route>
    </Routes>
  </BrowserRouter>,
);
