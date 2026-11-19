import type { CommentReplyItem } from '../../api/types'

/** 回复 = an answer to a comment (own account's or a tracked post's), 评论 = a comment directly under a post. */
export const replyKind = (r: Pick<CommentReplyItem, 'commentId' | 'trackedCommentId'>): 'reply' | 'comment' => (r.commentId || r.trackedCommentId ? 'reply' : 'comment')
/** A send's time on 排程发布 (same rule as the API's from/to): sent, else due, else submitted ("now" has no scheduledAt). */
export const replyTime = (r: CommentReplyItem): string => r.sentAt ?? r.scheduledAt ?? r.submittedAt ?? r.createdAt
/** Scheduled but parked while its phone is halted (风控): no task until an admin resumes the phone. */
export const replyParked = (r: CommentReplyItem): boolean => r.status === 'scheduled' && !r.taskId && r.errorCode === 'comment.device_halted'
