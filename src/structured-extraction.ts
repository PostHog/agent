import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { Logger } from './utils/logger.js';

export interface ExtractedQuestion {
  id: string;
  question: string;
  options: string[];
}

export interface ExtractedQuestionWithAnswer extends ExtractedQuestion {
  recommendedAnswer: string;
  justification: string;
}

const questionsOnlySchema = z.object({
  questions: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      options: z.array(z.string()),
    })
  ),
});

const questionsWithAnswersSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      options: z.array(z.string()),
      recommendedAnswer: z.string().describe('The letter of the recommended option (e.g., "a", "b", "c")'),
      justification: z.string().describe('Brief explanation for the recommended answer'),
    })
  ),
});

export interface StructuredExtractor {
  extractQuestions(researchContent: string): Promise<ExtractedQuestion[]>;
  extractQuestionsWithAnswers(researchContent: string): Promise<ExtractedQuestionWithAnswer[]>;
}

export class AISDKExtractor implements StructuredExtractor {
  private logger: Logger;
  private model: any;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger({ debug: false, prefix: '[AISDKExtractor]' });

    // Determine which provider to use based on environment variables
    // Priority: Anthropic (if ANTHROPIC_BASE_URL is set) > OpenAI
    const apiKey = process.env.ANTHROPIC_AUTH_TOKEN
      || process.env.ANTHROPIC_API_KEY
      || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error('Missing API key for structured extraction. Ensure the LLM gateway is configured.');
    }

    const baseURL = process.env.ANTHROPIC_BASE_URL || process.env.OPENAI_BASE_URL;
    const modelName = 'claude-haiku-4-5';
    this.model = anthropic(modelName);
    this.logger.debug('Using Anthropic provider for structured extraction', { modelName, baseURL });
  }

  async extractQuestions(researchContent: string): Promise<ExtractedQuestion[]> {
    this.logger.debug('Extracting questions from research content', {
      contentLength: researchContent.length,
    });

    const { object } = await generateObject({
      model: this.model,
      schema: questionsOnlySchema,
      schemaName: 'ResearchQuestions',
      schemaDescription: 'Research questions extracted from markdown content',
      system: 'Extract the research questions from the provided markdown. Return a JSON object matching the schema.',
      prompt: researchContent,
    });

    this.logger.info('Successfully extracted questions', {
      questionCount: object.questions.length,
    });

    return object.questions;
  }

  async extractQuestionsWithAnswers(
    researchContent: string,
  ): Promise<ExtractedQuestionWithAnswer[]> {
    this.logger.debug('Extracting questions with recommended answers', {
      contentLength: researchContent.length,
    });

    const { object } = await generateObject({
      model: this.model,
      schema: questionsWithAnswersSchema,
      schemaName: 'ResearchQuestionsWithAnswers',
      schemaDescription: 'Research questions with recommended answers extracted from markdown',
      system: 'Extract the research questions from the markdown and provide recommended answers based on the analysis. For each question, include a recommendedAnswer (the letter: a, b, c, etc.) and a brief justification. Return a JSON object matching the schema.',
      prompt: researchContent,
    });

    this.logger.info('Successfully extracted questions with answers', {
      questionCount: object.questions.length,
    });

    return object.questions;
  }
}
