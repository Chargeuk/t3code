import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createKnowledgeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const live = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:knowledge:live",
    tag: WS_METHODS.knowledgeSubscribe,
  });
  return {
    knowledgeLive: (environmentId: EnvironmentId) => live({ environmentId, input: {} }),
    knowledgeResolve: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:knowledge:resolve",
      tag: WS_METHODS.knowledgeResolve,
    }),
    knowledgeEmbeddingModels: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:knowledge:embedding-models",
      tag: WS_METHODS.knowledgeEmbeddingModels,
    }),
    knowledgeAdmit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:knowledge:admit",
      tag: WS_METHODS.knowledgeAdmit,
    }),
    knowledgeCancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:knowledge:cancel",
      tag: WS_METHODS.knowledgeCancel,
    }),
    knowledgeRemove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:knowledge:remove",
      tag: WS_METHODS.knowledgeRemove,
    }),
  };
}
