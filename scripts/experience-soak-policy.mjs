// Isolated scripted performance fixtures only; never loaded by production AI.
import assert from 'node:assert/strict';

export function seedExperienceCapacity(world) {
  const people = Object.values(world.state.agents), now = world.now();
  for (let i = 0; i < 3584; i++) world.event('message', {
    agent_id: people[i % 5].agent_id, name: people[i % 5].name,
    channel: 'nearby', text: `隔离容量样本 ${i}：仅用于性能测试。`,
  }, []);
  for (let i = 0; i < 512; i++) world.event('cooperation_completed', {
    cooperation_id: `coop_fixture_${i}`, template_id: 'camp_meal', revision: 1,
    status: 'completed', created_at: now - 1000, started_at: now - 900,
    invite_expires_at: now + 149000, expires_at: now + 899000, ended_at: now,
    members: people.slice(3).map((a, n) => ({agent_id:a.agent_id, role_id:n ? 'cook' : 'supplier', confirmed:true})),
    progress:[{step_id:'supply',progress:4,completed_at:now},{step_id:'cook',progress:1,completed_at:now}],
    escrow:{turnip:0}, public_result:{text:'隔离容量样本：两份浓汤', completed_at:now,
      items_by_agent:Object.fromEntries(people.slice(3).map(a=>[a.agent_id,{turnip_soup:1}]))},
  }, []);
  assert.equal(world.state.history.entries.length, 4096);
  world.save();
}

export function experienceLoadAction(o, index, policy, shared) {
  const action = (type, payload = {}) => ({type,payload}), self=o.self;
  if (index < 2) {
    if (!self.group_id) {
      if (index===0) return action('create_group');
      const invite=o.invitations?.find(i=>i.from_agent_id===shared.agentIds[0]);
      return invite ? action('respond_invite',{invite_id:invite.invite_id,accept:true}) : null;
    }
    if (index===0 && !policy.invited) {
      policy.invited=true;
      return action('invite',{group_id:self.group_id,target_agent_id:shared.agentIds[1]});
    }
    const game=o.game;
    if (index===0 && !policy.proposed && o.group?.members?.length>=2) {
      policy.proposed=true;
      return action('propose_game',{group_id:self.group_id,game_type:'word_chain'});
    }
    if (game?.status==='recruiting' && index===1 && !game.participants.includes(self.agent_id))
      return action('respond_game',{game_id:game.game_id,accept:true});
    if (game?.status==='active' && game.current_agent_id===self.agent_id) {
      const word=shared.words.find(w=>w[0]===game.last_word.at(-1) && !game.words.includes(w));
      assert.ok(word, 'isolated word chain has a candidate');
      return action('submit_word',{game_id:game.game_id,turn_id:game.turn_id,word});
    }
    if (game?.status!=='finished') return null;
  }
  if (index>=3) {
    const p=o.cooperation, invite=o.cooperation_invitations?.[0];
    if (index===3 && !p && !policy.proposed) {
      policy.proposed=true;
      return action('cooperation',{intent:'propose',template_id:'camp_meal',role_id:'supplier',target_agent_id:shared.agentIds[4],duration_seconds:900});
    }
    if (invite) return action('cooperation',{intent:'respond',cooperation_id:invite.cooperation_id,revision:invite.revision,role_id:invite.role_id,accept:true});
    if (p?.status==='active') {
      const ref={cooperation_id:p.cooperation_id,revision:p.revision};
      if (index===3 && p.escrow.turnip===0) return action('cooperation',{intent:'contribute',...ref});
      if (index===4 && p.escrow.turnip===4) return action('cooperation',{intent:'cook',...ref});
    }
    if (p?.status!=='completed') return null;
  }
  return action('say',{channel:'nearby',text:`隔离慢速控制端 ${index+1} 的公开消息 ${++policy.cycle}`});
}
