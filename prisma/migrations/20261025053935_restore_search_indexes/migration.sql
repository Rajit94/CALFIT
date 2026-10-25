-- CreateIndex
CREATE INDEX "gyms_name_trgm" ON "gyms" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "users_username_trgm" ON "users" USING GIN ("username" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "users_name_trgm" ON "users" USING GIN ("name" gin_trgm_ops);
