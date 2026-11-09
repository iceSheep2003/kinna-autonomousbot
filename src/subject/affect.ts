import { AppraisalSchema, type AffectState, type Appraisal } from './types.js';
import type { EvidenceReader, SubjectRepository } from './ports.js';

/** 历史评价只追加；针对人物/主题的感受与整体 mood 分开保存。 */
export class AffectService {
  constructor(private readonly repository: SubjectRepository, private readonly evidence: EvidenceReader) {}
  appraise(raw: Appraisal, now: number): AffectState {
    const appraisal = AppraisalSchema.parse(raw);
    this.evidence.assertExists(appraisal.evidence);
    this.repository.recordAppraisal(appraisal, now);
    return { valence: appraisal.valence, arousal: appraisal.arousal, description: appraisal.description, updatedAt: now };
  }
  read(target: string): AffectState | undefined { return this.repository.affectFor(target); }
}
