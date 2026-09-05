
// Use interface augmentation to add API_KEY to ProcessEnv.
// This avoids conflict with existing 'process' declaration from @types/node.
declare namespace NodeJS {
  interface ProcessEnv {
    API_KEY?: string;
  }
}

declare module "@google/genai" {
  export class GoogleGenAI {
    constructor(config: { apiKey: string | undefined });
    models: {
      generateContent: (params: {
        model: string;
        contents: Content[];
        config?: {
          tools?: Array<{ functionDeclarations?: FunctionDeclaration[] }>;
          systemInstruction?: string | Content;
        };
      }) => Promise<{
        candidates?: Array<{
          content?: Content;
        }>;
        functionCalls?: Array<{
          name: string;
          args: any;
        }>;
      }>;
    };
  }

  export enum Type {
    TYPE_UNSPECIFIED = 'TYPE_UNSPECIFIED',
    STRING = 'STRING',
    NUMBER = 'NUMBER',
    INTEGER = 'INTEGER',
    BOOLEAN = 'BOOLEAN',
    ARRAY = 'ARRAY',
    OBJECT = 'OBJECT',
    NULL = 'NULL'
  }

  export interface FunctionDeclaration {
    name: string;
    description: string;
    parameters: {
      type: Type;
      properties: Record<string, any>;
      required?: string[];
      description?: string;
    };
  }

  export interface Part {
    text?: string;
    inlineData?: {
      mimeType: string;
      data: string;
    };
    functionCall?: {
      name: string;
      args: any;
    };
    functionResponse?: {
      name: string;
      response: {
        result: any;
      };
    };
  }

  export interface Content {
    role: 'user' | 'model' | 'system';
    parts: Part[];
  }
}
