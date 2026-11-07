-- Forms + inbox (FormGrid pattern, MIT): one form block per kyte, submissions
-- inbox with status New → Contacted → Converted, notes, and follow-up date.
-- The form itself is a JSON document on FormBlock.fields (SurveyJS storage
-- pattern); submissions carry a JSON payload validated against it at submit
-- time. No file field — uploads would need S3/MinIO and no $0 storage answer
-- exists yet (deferred).

-- CreateTable
CREATE TABLE "FormBlock" (
    "id" TEXT NOT NULL,
    "kyteId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Contact me',
    "description" TEXT,
    "buttonText" TEXT NOT NULL DEFAULT 'Send message',
    "successText" TEXT NOT NULL DEFAULT 'Thanks! I''ll get back to you.',
    "fields" JSONB NOT NULL DEFAULT '[]',
    "endpointToken" TEXT NOT NULL,
    "notifyEmail" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormSubmission" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "kyteId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "spam" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "followUpAt" TIMESTAMP(3),
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FormBlock_kyteId_key" ON "FormBlock"("kyteId");

-- CreateIndex
CREATE UNIQUE INDEX "FormBlock_endpointToken_key" ON "FormBlock"("endpointToken");

-- CreateIndex
CREATE INDEX "FormBlock_orgId_idx" ON "FormBlock"("orgId");

-- CreateIndex
CREATE INDEX "FormSubmission_formId_status_createdAt_idx" ON "FormSubmission"("formId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "FormSubmission_kyteId_createdAt_idx" ON "FormSubmission"("kyteId", "createdAt");

-- CreateIndex
CREATE INDEX "FormSubmission_orgId_createdAt_idx" ON "FormSubmission"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "FormBlock" ADD CONSTRAINT "FormBlock_kyteId_fkey" FOREIGN KEY ("kyteId") REFERENCES "Kyte"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "FormBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
