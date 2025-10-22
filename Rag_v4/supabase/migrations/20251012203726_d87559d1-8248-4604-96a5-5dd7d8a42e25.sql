-- Move vector extension from public schema to extensions schema
CREATE SCHEMA IF NOT EXISTS extensions;

-- Move the vector extension to extensions schema
ALTER EXTENSION vector SET SCHEMA extensions;

-- Grant usage on extensions schema
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

-- Update the search_path for the match_document_chunks function to include extensions schema
CREATE OR REPLACE FUNCTION public.match_document_chunks(
  query_embedding vector,
  match_threshold double precision,
  match_count integer,
  filter_document_ids uuid[]
)
RETURNS TABLE(
  id uuid,
  document_id uuid,
  content text,
  similarity double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    document_chunks.id,
    document_chunks.document_id,
    document_chunks.content,
    1 - (document_chunks.embedding <=> query_embedding) AS similarity
  FROM document_chunks
  WHERE 
    document_chunks.document_id = ANY(filter_document_ids)
    AND 1 - (document_chunks.embedding <=> query_embedding) > match_threshold
  ORDER BY document_chunks.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;