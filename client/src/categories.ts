import type { Category } from './protocol';

export const CATEGORY_LABELS: Record<Category, string> = {
  bible: '성경',
  season: '교회절기',
  nature: '몸·자연',
  korean: '우리말',
  current: '시사',
  nonsense: '넌센스',
};

export const CATEGORY_CLASS: Record<Category, string> = {
  bible: 'category-bible',
  season: 'category-season',
  nature: 'category-nature',
  korean: 'category-korean',
  current: 'category-current',
  nonsense: 'category-nonsense',
};
