#!/usr/bin/env python3
"""把旧 bot 的数据迁到新项目。

三样东西值得搬：**记忆、人物、好感度**。
消息不搬（7907 条，结构差异大，新项目靠 experience 边跑边积累）。

字段映射：
  memories.user_id   → subject_user_id   （旧库这么叫）
  memories.*         → kind/revision/evidence 用默认值补齐
  people             → documents(collection='people')
  relations.affection→ documents(collection='rapport') 的 score
"""
import json
import sqlite3
import sys

OLD = sys.argv[1] if len(sys.argv) > 1 else '/opt/kinna-releases/20261108-133650-memory-identity-final/data/qunbot.sqlite3'
NEW = sys.argv[2] if len(sys.argv) > 2 else '/opt/kinna-agent/data/agent.sqlite'

old = sqlite3.connect(OLD)
old.row_factory = sqlite3.Row
new = sqlite3.connect(NEW)
new.row_factory = sqlite3.Row
report = {}


def migrate_memories():
    rows = old.execute('select * from memories').fetchall()
    done = 0
    for row in rows:
        # 旧的 user_id 是「关于谁」；新库叫 subject_user_id。
        subject = row['user_id'] or 'group'
        new.execute(
            '''insert or ignore into memories
               (id, content, scope, subject_user_id, visibility, origin_user_id, kind, fact_type,
                mention_policy, persona_summary, status, importance, confidence, revision,
                merged_into, source_event_id, expires_at, last_accessed_at, access_count,
                created_at, updated_at, evidence)
               values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]')''',
            (row['id'], row['content'], row['scope'] or 'owner', subject,
             row['visibility'] or 'personal', row['origin_user_id'], 'observation',
             row['fact_type'] or 'fact', row['mention_policy'] or 'soft_echo',
             row['persona_summary'] or '', row['status'] or 'active',
             row['importance'] or 1, row['confidence'] or 0.65, 0,
             row['merged_into'], row['source_event_id'], row['expires_at'],
             row['last_accessed_at'], row['access_count'] or 0,
             row['created_at'], row['updated_at'] or row['created_at']))
        done += 1
    new.commit()
    report['memories'] = done


def migrate_people():
    rows = old.execute('select user_id, nickname, updated_at from people').fetchall()
    done = 0
    for row in rows:
        person = {
            'userId': str(row['user_id']),
            'names': [row['nickname']] if row['nickname'] else [],
            'notes': [], 'portraitEvidence': [], 'groups': [],
            'firstSeenAt': row['updated_at'] or 0,
            'lastSeenAt': row['updated_at'] or 0,
        }
        new.execute('insert or replace into documents (collection, id, body) values (?,?,?)',
                    ('people', person['userId'], json.dumps(person, ensure_ascii=False)))
        done += 1
    new.commit()
    report['people'] = done


def migrate_relations():
    rows = old.execute('select group_id, user_id, affection, updated_at from relations').fetchall()
    done = 0
    for row in rows:
        # 新库的键是 scope\u0000userId；好感度是 -100..100，旧的 affection 也是同量级。
        key = f"group:{row['group_id']}\u0000{row['user_id']}"
        state = {'score': int(row['affection'] or 0), 'updatedAt': row['updated_at'] or 0,
                 'events': [{'at': row['updated_at'] or 0, 'delta': int(row['affection'] or 0),
                             'reason': '从旧版迁入', 'source': 'import'}]}
        new.execute('insert or replace into documents (collection, id, body) values (?,?,?)',
                    ('rapport', key, json.dumps(state, ensure_ascii=False)))
        done += 1
    new.commit()
    report['relations'] = done


for fn in (migrate_memories, migrate_people, migrate_relations):
    try:
        fn()
    except Exception as error:  # 单张表失败不该让整次迁移停下
        report[fn.__name__] = f'FAIL: {error}'

print(json.dumps(report, ensure_ascii=False))
print('新库统计:', dict(new.execute(
    "select collection, count(*) from documents group by collection").fetchall()))
print('新库记忆:', new.execute('select count(*) from memories').fetchone()[0])
