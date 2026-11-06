-- Retain only the unguessable student-link slug when a teacher deletes a
-- tapplet. No title, owner, revision, source or asset reference is retained.
CREATE TABLE deleted_publications (
  slug TEXT PRIMARY KEY
);
