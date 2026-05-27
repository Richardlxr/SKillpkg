import { logger } from './logger.js';

export const SELECT_ALL_CHOICE_VALUE = '__skm_select_all__';

export interface SearchableSelectionChoice<T extends string> {
  name: string;
  value: T;
  searchable: string;
}

export interface SearchableSelectionOptions<T extends string> {
  choices: SearchableSelectionChoice<T>[];
  itemLabel: string;
  queryName: string;
  selectionName: string;
  searchMessage?: (total: number) => string;
  selectMessage?: (matched: number, total: number, query: string) => string;
  noMatchesMessage?: (query: string) => string;
  includeSelectAll?: boolean;
}

export async function promptForSearchableSelection<T extends string>(
  options: SearchableSelectionOptions<T>
): Promise<T[]> {
  const { default: inquirer } = await import('inquirer');

  while (true) {
    const searchAnswer = await inquirer.prompt<Record<string, string | undefined>>([{
      type: 'input',
      name: options.queryName,
      message: options.searchMessage
        ? options.searchMessage(options.choices.length)
        : `Search ${options.itemLabel} (${options.choices.length} found, leave blank for all):`,
    }]);
    const query = (searchAnswer[options.queryName] || '').trim();
    const filteredChoices = filterSearchableChoices(options.choices, query);

    if (filteredChoices.length === 0) {
      logger.warn(options.noMatchesMessage
        ? options.noMatchesMessage(query)
        : `No ${options.itemLabel} matched "${query}". Try another keyword or leave blank to show all.`);
      continue;
    }

    const checkboxChoices: Array<{ name: string; value: string }> = filteredChoices.map(({ name, value }) => ({
      name,
      value,
    }));

    if (options.includeSelectAll && filteredChoices.length > 1) {
      checkboxChoices.unshift({
        name: `Select all ${filteredChoices.length} shown`,
        value: SELECT_ALL_CHOICE_VALUE,
      });
    }

    const answer = await inquirer.prompt<Record<string, string[]>>([{
      type: 'checkbox',
      name: options.selectionName,
      message: options.selectMessage
        ? options.selectMessage(filteredChoices.length, options.choices.length, query)
        : query
          ? `Found ${filteredChoices.length} of ${options.choices.length} ${options.itemLabel} matching "${query}". Select which ones to install:`
          : `Found ${options.choices.length} ${options.itemLabel}. Select which ones to install:`,
      choices: checkboxChoices,
      pageSize: Math.min(20, Math.max(checkboxChoices.length, 5)),
      validate: (ans: unknown) => Array.isArray(ans) && ans.length > 0
        ? true
        : `You must select at least one ${options.itemLabel}`,
    }]);

    const selected = answer[options.selectionName] || [];
    if (selected.includes(SELECT_ALL_CHOICE_VALUE)) {
      return filteredChoices.map(({ value }) => value);
    }

    return selected.filter((value): value is T => value !== SELECT_ALL_CHOICE_VALUE);
  }
}

export function filterSearchableChoices<T extends string>(
  choices: SearchableSelectionChoice<T>[],
  query: string
): SearchableSelectionChoice<T>[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) return choices;

  return choices.filter((choice) => {
    const searchable = choice.searchable.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}
