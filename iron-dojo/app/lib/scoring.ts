export type CheckResult = { label: string; passed: boolean };

export type ProductScores = {
  listingQuality: number;
  productHealth: number;
  revenueOpportunity: number;
  checks: CheckResult[];
};

export interface ScoredProduct {
  status: string;
  totalInventory: number | null;
  productType: string;
  vendor: string;
  title: string;
  descriptionHtml: string;
  tags: string[];
  images: { edges: unknown[] };
  variants: { edges: { node: { price: string } }[] };
  seo: { title: string | null; description: string | null } | null;
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function scoreProduct(product: ScoredProduct): ProductScores {
  const imageCount = product.images.edges.length;

  const checks: CheckResult[] = [
    {
      label: "Status is not Active",
      passed: product.status === "ACTIVE",
    },
    {
      label: "Inventory is zero or missing",
      passed: (product.totalInventory ?? 0) > 0,
    },
    {
      label: "Product type is missing",
      passed: product.productType.trim().length > 0,
    },
    {
      label: "Vendor is missing",
      passed: product.vendor.trim().length > 0,
    },
    {
      label: "Title is shorter than 20 characters",
      passed: product.title.trim().length >= 20,
    },
    {
      label: "Description is missing or under 100 characters",
      passed: stripHtml(product.descriptionHtml).length >= 100,
    },
    {
      label: "Fewer than 5 tags",
      passed: product.tags.length >= 5,
    },
    {
      label: "Fewer than 3 images",
      passed: imageCount >= 3,
    },
    {
      label: "No variant price found",
      passed: parseFloat(product.variants.edges[0]?.node.price ?? "0") > 0,
    },
    {
      label: "SEO title is missing",
      passed: (product.seo?.title ?? "").trim().length > 0,
    },
    {
      label: "SEO meta description is missing",
      passed: (product.seo?.description ?? "").trim().length > 0,
    },
  ];

  const weights = [15, 10, 5, 5, 10, 15, 10, 10, 5, 8, 7];
  const listingQuality = checks.reduce(
    (sum, check, i) => sum + (check.passed ? weights[i] : 0),
    0,
  );

  return {
    listingQuality,
    productHealth: listingQuality,
    revenueOpportunity: 100 - listingQuality,
    checks,
  };
}

export function scoreTone(
  score: number,
): "success" | "caution" | "critical" {
  if (score >= 80) return "success";
  if (score >= 50) return "caution";
  return "critical";
}

export function revOpportunityTone(
  score: number,
): "success" | "caution" | "critical" {
  if (score >= 80) return "critical";
  if (score >= 50) return "caution";
  return "success";
}

export function revOpportunityLabel(score: number): string {
  if (score >= 80) return "High opportunity";
  if (score >= 50) return "Moderate opportunity";
  return "Low opportunity";
}
