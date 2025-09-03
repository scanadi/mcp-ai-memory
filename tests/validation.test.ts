import { describe, expect, test } from 'bun:test';
import {
  StoreMemorySchema,
  SearchMemorySchema,
  UpdateMemorySchema,
  ListMemorySchema,
} from '../src/schemas/validation';

describe('Validation Schemas', () => {
  describe('StoreMemorySchema', () => {
    test('should validate correct input', () => {
      const input = {
        content: 'Test content',
        type: 'fact',
        tags: ['test', 'validation'],
        source: 'test-suite',
        confidence: 0.8,
      };

      const result = StoreMemorySchema.parse(input);
      expect(result).toBeDefined();
      expect(result.content).toBe('Test content');
    });

    test('should sanitize tags with special characters', () => {
      const input = {
        content: 'Test content',
        type: 'fact',
        tags: ['test@123', 'validation!', '<script>alert()</script>'],
        source: 'test-suite',
        confidence: 0.8,
      };

      const result = StoreMemorySchema.parse(input);
      expect(result.tags).toEqual(['test123', 'validation', 'scriptalertscript']);
    });

    test('should sanitize string fields', () => {
      const input = {
        content: 'Test content',
        type: 'fact',
        source: 'test\x00suite\x01with\x1Fcontrol',
        confidence: 0.8,
        user_context: 'user\x00context',
      };

      const result = StoreMemorySchema.parse(input);
      expect(result.source).toBe('testsuitewithcontrol');
      expect(result.user_context).toBe('usercontext');
    });

    test('should reject invalid confidence', () => {
      const input = {
        content: 'Test content',
        type: 'fact',
        source: 'test',
        confidence: 1.5, // Invalid: > 1
      };

      expect(() => StoreMemorySchema.parse(input)).toThrow();
    });

    test('should reject content exceeding size limit', () => {
      const largeContent = 'x'.repeat(1048577); // 1MB + 1 byte
      const input = {
        content: largeContent,
        type: 'fact',
        source: 'test',
        confidence: 0.8,
      };

      expect(() => StoreMemorySchema.parse(input)).toThrow();
    });

    test('should reject too many tags', () => {
      const input = {
        content: 'Test content',
        type: 'fact',
        tags: Array(21).fill('tag'), // 21 tags (max is 20)
        source: 'test',
        confidence: 0.8,
      };

      expect(() => StoreMemorySchema.parse(input)).toThrow();
    });
  });

  describe('SearchMemorySchema', () => {
    test('should validate search input', () => {
      const input = {
        query: 'test query',
        type: 'fact',
        tags: ['test'],
        limit: 50,
        threshold: 0.8,
      };

      const result = SearchMemorySchema.parse(input);
      expect(result.query).toBe('test query');
      expect(result.limit).toBe(50);
    });

    test('should sanitize query string', () => {
      const input = {
        query: 'test\x00query\x1Fwith\ncontrol',
      };

      const result = SearchMemorySchema.parse(input);
      expect(result.query).toBe('testquerywith\ncontrol'); // Newlines are preserved
    });

    test('should apply default values', () => {
      const input = {
        query: 'test',
      };

      const result = SearchMemorySchema.parse(input);
      expect(result.limit).toBe(10);
      expect(result.threshold).toBe(0.7);
    });

    test('should reject invalid limit', () => {
      const input = {
        query: 'test',
        limit: 101, // Max is 100
      };

      expect(() => SearchMemorySchema.parse(input)).toThrow();
    });
  });

  describe('UpdateMemorySchema', () => {
    test('should validate update input', () => {
      const input = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        updates: {
          tags: ['updated'],
          confidence: 0.9,
        },
      };

      const result = UpdateMemorySchema.parse(input);
      expect(result.id).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(result.updates.tags).toEqual(['updated']);
    });

    test('should reject invalid UUID', () => {
      const input = {
        id: 'not-a-uuid',
        updates: {},
      };

      expect(() => UpdateMemorySchema.parse(input)).toThrow();
    });
  });

  describe('ListMemorySchema', () => {
    test('should validate list input with defaults', () => {
      const input = {
        type: 'fact',
      };

      const result = ListMemorySchema.parse(input);
      expect(result.type).toBe('fact');
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(0);
    });

    test('should sanitize tags in list', () => {
      const input = {
        tags: ['test@123', 'valid_tag'],
      };

      const result = ListMemorySchema.parse(input);
      expect(result.tags).toEqual(['test123', 'valid_tag']);
    });
  });
});