import type { NextApiRequest, NextApiResponse } from "next";
import { supabase } from "../../lib/supabaseClient";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { name, email, company, phone } = req.body;

  if (!email) return res.status(400).json({ error: "Email is required" });

  const { error } = await supabase.from("leads").insert([
    { name, email, company, phone, docs_accessed: false }
  ]);

  if (error) return res.status(500).json({ error: error.message });

  res.status(200).json({ message: "Lead captured successfully" });
}
