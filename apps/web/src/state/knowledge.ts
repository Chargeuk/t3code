import { createKnowledgeEnvironmentAtoms } from "@t3tools/client-runtime/state/knowledge";

import { connectionAtomRuntime } from "../connection/runtime";

export const knowledgeEnvironment = createKnowledgeEnvironmentAtoms(connectionAtomRuntime);
