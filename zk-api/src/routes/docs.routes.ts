import { Router } from "express";
import { apiReference } from "@scalar/express-api-reference";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/// The specification, served by the service it describes, and reachable without
/// credentials: an integrator has to be able to read the contract before they hold a
/// partner key, and a document that lives anywhere other than beside the code it
/// describes is a document that drifts from it. Same arrangement as Component 1.
///
/// Nothing here reaches the database or the chain, and nothing here is authenticated,
/// so these two routes sit outside `/v1` rather than carrying an exemption inside it.
///
/// The renderer is a script from a CDN, pinned to a major so the page cannot change shape
/// underneath the document it renders. The document itself is served from disk and needs
/// nothing from the network, which is what a deployment without outbound access reads.

export const OPENAPI_DOCUMENT_PATH = resolve(import.meta.dirname, "../../openapi.yaml");

export const docsRouter: Router = Router();

const document = () => readFileSync(OPENAPI_DOCUMENT_PATH, "utf8");

docsRouter.get("/api/openapi.yaml", (_req, res) => {
  res.type("application/yaml").send(document());
});

docsRouter.get(
  "/api/docs",
  apiReference({
    url: "/api/openapi.yaml",
    pageTitle: "VCSoft confidentiality layer — verification API",
    cdn: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1",
  }),
);
