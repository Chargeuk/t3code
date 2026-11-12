import { createFileRoute } from "@tanstack/react-router";

import { KnowledgePage } from "../components/knowledge/KnowledgePage";

export const Route = createFileRoute("/_chat/knowledge")({
  component: KnowledgePage,
});
