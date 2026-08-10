import { $api } from "./client";

export const useImportIsbn = () =>
  $api.useMutation("post", "/api/vault/academic/import/isbn");
