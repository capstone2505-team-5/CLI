export interface RootSpan {
  id: string;
  traceId: string;
  startTime: string | null;      // or Date
  endTime: string | null;        // or Date
  input: string;
  output: string;
  projectId: string;
  spanName: string | null;
}

export interface FetchRootSpanReturn {
  rootSpans: RootSpan[];
  endCursor: string;
  hasNextPage: boolean;
}

export interface GraphQLRootSpanResponse {
  data?: {
    projects?: {
      edges?: Array<{
        node?: {
          id?: string;
          spans?: {
            edges?: Array<{
              node?: {
                context?: { spanId: string; traceId: string };
                input?: { value: string };
                output?: { value: string };
                startTime?: string;
                endTime?: string;
                name?: string;
                spanKind?: string;
              };
            }>;
            pageInfo?: {
              endCursor: string;
              hasNextPage: boolean;
            }
          };
        };
      }>;
    };
  };
}

export interface ProjectEdge {
  node?: {
    id?: string;
    spans?: {
      edges?: SpanEdge[];
      pageInfo?: {
        endCursor: string;
        hasNextPage: boolean;
      }
    };
  };
}

export interface SpanEdge {
  node?: {
    context?: {
      spanId: string;
      traceId: string;
    };
    input?: {
      value: string;
    };
    output?: {
      value: string;
    };
    startTime?: string;
    endTime?: string;
    name?: string;
    id?: string;
    spanKind?: string;
  };
}