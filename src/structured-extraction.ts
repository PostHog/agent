import { generateObject } from 'ai';
import { z } from 'zod';
import { Logger } from './utils/logger.js';
import { getAnthropicModel } from './utils/ai-sdk.js';

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

export type StructuredExtractorConfig = {
  apiKey: string;
  baseURL: string;
  modelName?: string;
  logger?: Logger;
}

export class AISDKExtractor implements StructuredExtractor {
  private logger: Logger;
  private model: any;

  constructor(config: StructuredExtractorConfig) {
    this.logger = config.logger || new Logger({ debug: false, prefix: '[AISDKExtractor]' });

    if (!config.apiKey) {
      throw new Error('Missing API key for structured extraction. Ensure the LLM gateway is configured.');
    }

    this.model = getAnthropicModel({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      modelName: config.modelName || 'claude-haiku-4-5',
    });

    this.logger.debug('Using PostHog LLM gateway for structured extraction', {
      modelName: config.modelName || 'claude-haiku-4-5',
      baseURL: config.baseURL
    });
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
