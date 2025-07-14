import { getLogger } from '../utils';
import type { FetchResult } from '../interfaces/lyricTypes';
import type { LyricFetcher } from '../interfaces/fetcher';
import { prisma } from '../db';
import type { LyricFormat } from '../utils';

const logger = getLogger('RepositoryFetcher');

/**
 * Fetches lyrics from the database.
 */
export class RepositoryFetcher implements LyricFetcher {
  async fetch(id: string, format: LyricFormat): Promise<FetchResult> {
    logger.info(`Attempting fetch for ${format.toUpperCase()} for track ${id} from database`);
    try {
      const lyric = await prisma.lyric.findUnique({
        where: {
          trackId_format: {
            trackId: id,
            format: format,
          },
        },
      });

      if (lyric) {
        logger.info(`Success for ${format.toUpperCase()} for track ${id} from database`);
        return { status: 'found', format, content: lyric.content, source: 'repository' };
      } else {
        logger.info(`No lyric found for ${format.toUpperCase()} for track ${id} in database`);
        return { status: 'notfound', format };
      }
    } catch (err) {
      logger.error(`Database error for ${format.toUpperCase()} for track ${id}`, err);
      const error = err instanceof Error ? err : new Error('Unknown database error');
      return { status: 'error', format, error };
    }
  }
}
