export { KnowledgeBase, KBIntegrityError } from "./kb.js";
export type { KBEntry, KBEntryTier, KbStore } from "./kb.js";
export { saveKBProjection, loadKBResult, saveKBToSqlite, loadKBFromSqlite } from "./persist.js";
export { SqliteKbStore } from "./sqlite.js";
export {
  DEFAULT_KB_INJECT_TOP_K,
  VENDORED_LEXICAL_MODEL,
  cosineSimilarity,
  kbEntryRankingText,
  loadVendoredEmbeddingPort,
  reportDegradedLexicalRetrieval,
  selectTopK,
} from "./retrieval.js";
export type { EmbeddingPort, TopKSelection, VendoredLexicalModelSpec } from "./retrieval.js";
export {
  evaluateKnowledgeBaseRetrieval,
  evaluateKnowledgeBaseRetrievalAblation,
} from "./retrieval-eval.js";
export type {
  KnowledgeBaseRetrievalCohort,
  KnowledgeBaseRetrievalTask,
  KnowledgeBaseRetrievalEvaluation,
  KnowledgeBaseRetrievalAblation,
} from "./retrieval-eval.js";
