/**
 * Reserved owner id of EULEX context documents. A UUID because
 * documents.user_id is uuid-typed in production; no user has this id, so
 * these files never show up in anyone's document list.
 */
export const SYSTEM_CONTEXT_OWNER = "e1e00000-0000-4000-8000-000000000001";
