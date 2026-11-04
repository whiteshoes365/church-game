import type { Category } from './protocol';

export const CATEGORY_LABELS: Record<Category, string> = {
  bible: '성경',
  nonsense: '넌센스',
};

export const CATEGORY_CLASS: Record<Category, string> = {
  bible: 'category-bible',
  nonsense: 'category-nonsense',
};
