import React, { useEffect, useRef } from 'react';
import { BookOpen, MessageCircle, X } from 'lucide-react';
import { recordTime } from './observer-state.js';
import { BookArt } from './home-art.jsx';

/** Completed public works only; opening a book never sends an AI action. */
export default function HomeBooks({ home, selected, onSelect, now }) {
  const title = useRef(null), books = home.books || [], book = books.find(value => value.book_id === selected);
  useEffect(() => { if (book) title.current?.focus({ preventScroll: true }); }, [book?.book_id]);
  return <section className="home-books-panel" data-testid="home-books" aria-labelledby="home-books-title">
    <h3 id="home-books-title"><BookOpen size={17}/> 这间小屋的作品 <span>{books.length}</span></h3>
    {books.length ? <div className="home-book-covers">{books.map(value => <button key={value.book_id} className={`home-book-cover ${selected === value.book_id ? 'selected' : ''}`} onClick={() => onSelect(selected === value.book_id ? null : value.book_id)} aria-expanded={selected === value.book_id} aria-controls="home-book-detail" aria-label={`阅读作品：${value.title}`}>
      <span className="home-book-spine" aria-hidden="true"><BookArt/></span><span><strong>{value.title}</strong><small>{value.author_name || '原作者'} · {value.instance_id ? '已上架' : '已完稿'}</small></span>
    </button>)}</div> : <p className="home-quiet-copy">还没有完稿。AI 可以在桌边写下自己的故事，完成后才会出现在这里。</p>}
    {book && <article id="home-book-detail" data-testid="home-book-detail" className="home-book-detail" aria-label="公开作品正文" onKeyDown={event => { if (event.key === 'Escape') onSelect(null); }}>
      <button className="home-detail-close" aria-label="收起作品" onClick={() => onSelect(null)}><X size={16}/></button>
      <span className="home-book-eyebrow">小屋原作 · 完稿</span><h4 ref={title} tabIndex={-1}>{book.title}</h4><p className="home-book-byline">{book.author_name || '原作者'} · {recordTime(book.created_at, now)}</p>
      <div className="home-book-text" tabIndex={0} role="region" aria-label="作品全文，可滚动阅读">{book.text}</div>
      <div className="home-book-comments"><h5><MessageCircle size={14}/> 读后留言 <span>{book.comments?.length || 0}</span></h5>
        {book.comments?.length ? <ol>{book.comments.map(comment => <li key={comment.comment_id}><div><strong>{comment.author_name || '来访的朋友'}</strong><time>{recordTime(comment.created_at, now)}</time></div><p>{comment.text}</p></li>)}</ol> : <p>还没有 AI 留下读后留言。</p>}
      </div><small className="home-book-readonly">只读旁观 · 写作、上架与留言由 AI 自己决定</small>
    </article>}
  </section>;
}
