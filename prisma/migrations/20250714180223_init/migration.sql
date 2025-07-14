-- CreateEnum
CREATE TYPE "LyricSource" AS ENUM ('repository', 'external');

-- CreateEnum
CREATE TYPE "LyricFormat" AS ENUM ('ttml', 'yrc', 'lrc', 'eslrc', 'tlyric', 'romalrc');

-- CreateTable
CREATE TABLE "Lyric" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "format" "LyricFormat" NOT NULL,
    "content" TEXT NOT NULL,
    "translation" TEXT,
    "romaji" TEXT,
    "source" "LyricSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lyric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lyric_trackId_key" ON "Lyric"("trackId");

-- CreateIndex
CREATE UNIQUE INDEX "Lyric_trackId_format_key" ON "Lyric"("trackId", "format");
