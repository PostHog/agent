import OpenAI from 'openai';
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

const questionsOnlySchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['id', 'question', 'options'],
        additionalProperties: false
      }
    }
  },
  required: ['questions'],
  additionalProperties: false
};

const questionsWithAnswersSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'string' }
          },
          recommendedAnswer: { type: 'string' },
          justification: { type: 'string' }
        },
        required: ['id', 'question', 'options', 'recommendedAnswer', 'justification'],
        additionalProperties: false
      }
    }
  },
  required: ['questions'],
  additionalProperties: false
};

export interface StructuredExtractor {
  extractQuestions(researchContent: string): Promise<ExtractedQuestion[]>;
  extractQuestionsWithAnswers(researchContent: string): Promise<ExtractedQuestionWithAnswer[]>;
}

export class OpenAIExtractor implements StructuredExtractor {
  private client: OpenAI;
  private logger: Logger;

  constructor(logger?: Logger) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required for structured extraction');
    }
    
    this.client = new OpenAI({ apiKey });
    this.logger = logger || new Logger({ debug: false, prefix: '[OpenAIExtractor]' });
  }

  async extractQuestions(researchContent: string): Promise<ExtractedQuestion[]> {
    this.logger.debug('Extracting questions from research content', {
      contentLength: researchContent.length,
    });

    const completion = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Extract the research questions from the provided markdown. Return a JSON object matching the schema.',
        },
        {
          role: 'user',
          content: researchContent,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'questions',
          strict: true,
          schema: questionsOnlySchema,
        },
      },
    });

    const content = completion.choices[0].message.content;
    if (!content) {
      throw new Error('No content in OpenAI response');
    }

    const parsed = JSON.parse(content) as { questions: ExtractedQuestion[] };
    
    this.logger.info('Successfully extracted questions', {
      questionCount: parsed.questions.length,
    });

    return parsed.questions;
  }

  async extractQuestionsWithAnswers(
    researchContent: string,
  ): Promise<ExtractedQuestionWithAnswer[]> {
    this.logger.debug('Extracting questions with recommended answers', {
      contentLength: researchContent.length,
    });

    const completion = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Extract the research questions from the markdown and provide recommended answers based on the analysis. For each question, include a recommendedAnswer (the letter: a, b, c, etc.) and a brief justification. Return a JSON object matching the schema.',
        },
        {
          role: 'user',
          content: researchContent,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'questions_with_answers',
          strict: true,
          schema: questionsWithAnswersSchema,
        },
      },
    });

    const content = completion.choices[0].message.content;
    if (!content) {
      throw new Error('No content in OpenAI response');
    }

    const parsed = JSON.parse(content) as { questions: ExtractedQuestionWithAnswer[] };
    
    this.logger.info('Successfully extracted questions with answers', {
      questionCount: parsed.questions.length,
    });

    return parsed.questions;
  }
}
