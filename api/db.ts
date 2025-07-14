import { PrismaClient } from '../src/generated/prisma/edge';
import { withAccelerate } from '@prisma/extension-accelerate';

declare global {
  // allow global `var` declarations
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const prisma = new PrismaClient({
    log: ['query'],
}).$extends(withAccelerate());
